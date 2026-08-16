//! Per-process tree CPU% / RSS metrics (Linux /proc-based).
//! Mirrors src/lib/processMetrics.ts.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::SystemTime;

use once_cell::sync::Lazy;
use serde::Serialize;

use crate::core::process_map::{
    build_child_map, is_claude_background_task_process, parse_proc_stat,
};

const CLK_TCK: u64 = 100; // Linux sysconf(_SC_CLK_TCK); effectively always 100.

#[derive(Debug, Clone, Default, Serialize)]
pub struct ProcessTreeMetrics {
    pub pids: Vec<u32>,
    pub cpu_pct: f64,
    pub mem_kb: u64,
    pub background_task_count: usize,
}

#[derive(Clone)]
struct Sample {
    ticks: u64,
    wall_s: f64,
}

static PREV_SAMPLE: Lazy<Mutex<HashMap<u32, Sample>>> = Lazy::new(|| Mutex::new(HashMap::new()));

static CHILD_CACHE: Lazy<Mutex<Option<(u64, HashMap<u32, Vec<u32>>)>>> =
    Lazy::new(|| Mutex::new(None));

const CHILD_CACHE_TTL_MS: u64 = 1000;

fn is_linux() -> bool {
    cfg!(target_os = "linux")
}

fn read_uptime() -> f64 {
    if !is_linux() {
        return 0.0;
    }
    match std::fs::read_to_string("/proc/uptime") {
        Ok(s) => s
            .split_whitespace()
            .next()
            .and_then(|t| t.parse::<f64>().ok())
            .unwrap_or(0.0),
        Err(_) => 0.0,
    }
}

fn read_vm_rss_kb(pid: u32) -> u64 {
    if !is_linux() {
        return 0;
    }
    match std::fs::read_to_string(format!("/proc/{pid}/status")) {
        Ok(s) => {
            for line in s.lines() {
                if line.starts_with("VmRSS:") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 {
                        if let Ok(n) = parts[1].parse::<u64>() {
                            return n;
                        }
                    }
                }
            }
            0
        }
        Err(_) => 0,
    }
}

fn read_ticks_and_start(pid: u32) -> (u64, u64) {
    if !is_linux() {
        return (0, 0);
    }
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(s) => match parse_proc_stat(&s) {
            Some(stat) => (stat.utime + stat.stime, stat.starttime),
            None => (0, 0),
        },
        Err(_) => (0, 0),
    }
}

fn get_cached_child_map() -> HashMap<u32, Vec<u32>> {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Ok(guard) = CHILD_CACHE.lock() {
        if let Some((expires, map)) = guard.as_ref() {
            if *expires > now {
                return map.clone();
            }
        }
    }
    let map = build_child_map();
    if let Ok(mut guard) = CHILD_CACHE.lock() {
        *guard = Some((now + CHILD_CACHE_TTL_MS, map.clone()));
    }
    map
}

fn collect_tree(root_pid: u32, child_map: &HashMap<u32, Vec<u32>>) -> (Vec<u32>, usize) {
    let mut out = Vec::new();
    let mut background_task_count = 0usize;
    let mut seen = std::collections::HashSet::new();
    let mut queue = vec![root_pid];
    while let Some(pid) = queue.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if pid != root_pid && is_claude_background_task_process(pid) {
            background_task_count += 1;
            continue;
        }
        out.push(pid);
        if let Some(children) = child_map.get(&pid) {
            for c in children {
                if !seen.contains(c) {
                    queue.push(*c);
                }
            }
        }
    }
    (out, background_task_count)
}

fn average_since_start(root_pid: u32, total_ticks: u64, now: f64) -> f64 {
    let (_ticks, starttime) = read_ticks_and_start(root_pid);
    if starttime == 0 {
        return 0.0;
    }
    let elapsed_s = now - (starttime as f64 / CLK_TCK as f64);
    if elapsed_s <= 0.0 {
        return 0.0;
    }
    ((total_ticks as f64 / CLK_TCK as f64) / elapsed_s) * 100.0
}

/// CPU% and RSS for the process tree rooted at `root_pid`. CPU% is delta-sampled.
pub fn get_process_tree_metrics(root_pid: u32) -> ProcessTreeMetrics {
    if !is_linux() || root_pid == 0 {
        return ProcessTreeMetrics::default();
    }
    let child_map = get_cached_child_map();
    let (pids, background_task_count) = collect_tree(root_pid, &child_map);
    let mut total_ticks = 0u64;
    let mut total_mem = 0u64;
    for &pid in &pids {
        let (ticks, _) = read_ticks_and_start(pid);
        total_ticks += ticks;
        total_mem += read_vm_rss_kb(pid);
    }

    let now = read_uptime();
    let cpu_pct = {
        let mut prev = PREV_SAMPLE.lock().unwrap();
        let sample_opt = prev.get(&root_pid).cloned();
        let cpu = match sample_opt {
            Some(s) if now > s.wall_s => {
                let d_ticks = total_ticks.saturating_sub(s.ticks);
                ((d_ticks as f64 / CLK_TCK as f64) / (now - s.wall_s)) * 100.0
            }
            _ => average_since_start(root_pid, total_ticks, now),
        };
        prev.insert(
            root_pid,
            Sample {
                ticks: total_ticks,
                wall_s: now,
            },
        );
        if !cpu.is_finite() || cpu < 0.0 {
            0.0
        } else {
            cpu
        }
    };

    ProcessTreeMetrics {
        pids,
        cpu_pct,
        mem_kb: total_mem,
        background_task_count,
    }
}

/// Clear delta-sampling state (call at the start of a fresh one-shot/watch run).
pub fn reset_cpu_sampler() {
    if let Ok(mut prev) = PREV_SAMPLE.lock() {
        prev.clear();
    }
    if let Ok(mut cache) = CHILD_CACHE.lock() {
        *cache = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_metrics_off_linux_or_zero() {
        // On Linux with pid 0, returns empty; on non-linux, also empty.
        let m = get_process_tree_metrics(0);
        assert!(m.pids.is_empty());
        assert_eq!(m.cpu_pct, 0.0);
        assert_eq!(m.mem_kb, 0);
    }

    #[test]
    fn reset_does_not_panic() {
        reset_cpu_sampler();
        reset_cpu_sampler();
    }
}
