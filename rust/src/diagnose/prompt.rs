//! Judge prompt builder + verdict parser.

use crate::diagnose::{EvaluateeResult, JudgeVerdict, PersonalityAssessment, Task};

/// Build the single user prompt handed to the judge agent.
pub fn build_judge_prompt(task: &Task, evaluatees: &[EvaluateeResult]) -> String {
    let mut lines: Vec<String> = Vec::new();

    lines.push("你是一位 LLM 性格评估专家。下面是一项 LLM 性格倾向测试，以及若干被评估 agent 的真实回答。".to_string());
    lines.push("请根据每个 agent 的回答，判断其性格类型，并对每个维度打 1-5 分。".to_string());
    lines.push(String::new());

    lines.push(format!("## 测试：{}", task.name));
    if !task.description.is_empty() {
        lines.push(task.description.clone());
    }
    lines.push(String::new());

    lines.push("## 题目与评分指引".to_string());
    for (i, q) in task.questions.iter().enumerate() {
        lines.push(format!("{}. [{}]", i + 1, q.dimension));
        lines.push(format!("题目：{}", q.prompt));
        lines.push(format!("判断参考：{}", q.rubric));
        lines.push(String::new());
    }

    lines.push("## 维度评分表（1-5 分）".to_string());
    lines.push("| 维度 | 1 分 (low) | 5 分 (high) |".to_string());
    lines.push("| --- | --- | --- |".to_string());
    for dim in &task.scoring_dimensions {
        lines.push(format!("| {} | {} | {} |", dim.name, dim.low, dim.high));
    }
    lines.push(String::new());

    if !task.judge_instructions.is_empty() {
        lines.push("## 总体归类指引".to_string());
        lines.push(task.judge_instructions.clone());
        lines.push(String::new());
    }

    lines.push("## 被评估 agent 的回答".to_string());
    for (idx, ev) in evaluatees.iter().enumerate() {
        lines.push(String::new());
        lines.push(format!("### Agent {}: {}", idx + 1, ev.profile_label));
        if let Some(err) = &ev.error {
            lines.push(format!("(该 agent 执行出错：{}，无法评估，请在 assessments 中用 personalityType \"评估失败\" 标注。)", err));
            continue;
        }
        for r in &ev.results {
            let q_index = task.questions.iter().position(|q| q.id == r.question_id);
            let q_label = q_index.map(|i| format!("Q{}", i + 1)).unwrap_or_else(|| r.question_id.clone());
            let dimension = q_index.and_then(|i| task.questions.get(i)).map(|q| q.dimension.as_str()).unwrap_or("");
            lines.push(format!("{} [{}]", q_label, dimension));
            lines.push(format!("问：{}", r.prompt));
            let answer = if r.timed_out {
                "(超时未响应)".to_string()
            } else if r.response.is_empty() {
                "(空回答)".to_string()
            } else {
                r.response.clone()
            };
            lines.push(format!("答：{}", answer));
        }
    }

    lines.push(String::new());
    lines.push("## 输出要求".to_string());
    lines.push("只输出一个 JSON 对象，不要 markdown 代码块，不要任何额外说明。格式如下：".to_string());
    lines.push(
        "{\"assessments\":[{\"profileLabel\":\"<与上面完全一致的 profileLabel>\",\"personalityType\":\"<性格类型>\",\"scores\":{\"服从性\":1,\"边界感\":3,...},\"rationale\":\"<判断依据，简明扼要>\"}]}".to_string()
    );
    lines.push(format!("scores 必须包含全部 {} 个维度，每个值为 1-5 的整数。", task.scoring_dimensions.len()));
    lines.push("assessments 的数量和顺序要与被评估 agent 一致。".to_string());

    lines.join("\n")
}

/// Defensively parse the judge's JSON verdict. Strips markdown fences and
/// leading/trailing prose, extracts the outermost JSON object, and tolerates
/// missing/invalid scores. Never panics.
pub fn parse_judge_verdict(raw: &str, evaluatees: &[EvaluateeResult]) -> JudgeVerdict {
    let assessments: Vec<PersonalityAssessment> = Vec::new();

    if raw.trim().is_empty() {
        return JudgeVerdict {
            assessments,
            raw: raw.to_string(),
            exit_code: 0,
            duration_ms: 0,
            parse_error: Some("Judge returned empty output.".to_string()),
        };
    }

    // Strip markdown fences (greedy, case-insensitive).
    let stripped = strip_markdown_fences(raw);
    let first_brace = stripped.find('{');
    let last_brace = stripped.rfind('}');
    if first_brace.is_none() || last_brace.is_none() || last_brace < first_brace {
        return JudgeVerdict {
            assessments,
            raw: raw.to_string(),
            exit_code: 0,
            duration_ms: 0,
            parse_error: Some("Judge output contained no JSON object.".to_string()),
        };
    }
    let slice = &stripped[first_brace.unwrap()..=last_brace.unwrap()];

    let parsed: serde_json::Value = match serde_json::from_str(slice) {
        Ok(v) => v,
        Err(e) => {
            return JudgeVerdict {
                assessments,
                raw: raw.to_string(),
                exit_code: 0,
                duration_ms: 0,
                parse_error: Some(format!("Judge JSON parse failed: {}", e)),
            };
        }
    };

    let arr = match parsed.get("assessments").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => {
            return JudgeVerdict {
                assessments,
                raw: raw.to_string(),
                exit_code: 0,
                duration_ms: 0,
                parse_error: Some("Judge JSON missing `assessments` array.".to_string()),
            };
        }
    };

    let expected_labels: Vec<String> = evaluatees.iter().map(|e| e.profile_label.clone()).collect();
    let mut out: Vec<PersonalityAssessment> = Vec::new();
    for entry in arr {
        let profile_label = entry.get("profileLabel").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let label = if profile_label.is_empty() {
            expected_labels.get(out.len()).cloned().unwrap_or_else(|| format!("agent-{}", out.len() + 1))
        } else {
            profile_label
        };
        let personality_type = entry.get("personalityType").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let rationale = entry.get("rationale").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let mut scores: std::collections::BTreeMap<String, i32> = std::collections::BTreeMap::new();
        if let Some(scores_obj) = entry.get("scores").and_then(|v| v.as_object()) {
            for (k, v) in scores_obj {
                let n = v.as_i64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
                    .unwrap_or(0);
                if n != 0 {
                    let clamped = n.max(1).min(5) as i32;
                    scores.insert(k.clone(), clamped);
                }
            }
        }
        out.push(PersonalityAssessment {
            profile_label: label,
            personality_type,
            scores,
            rationale,
        });
    }

    JudgeVerdict {
        assessments: out,
        raw: raw.to_string(),
        exit_code: 0,
        duration_ms: 0,
        parse_error: None,
    }
}

/// Strip leading ` ```json ` / ` ``` ` and trailing ` ``` ` fences, case-insensitive.
fn strip_markdown_fences(raw: &str) -> String {
    // Find first triple-backtick fence.
    let bytes = raw.as_bytes();
    let mut start = 0;
    let mut end = raw.len();
    if let Some(s) = find_substring_no_case(raw, "```") {
        // Skip past the fence line
        let after = &raw[s + 3..];
        let lang_skip = after.find(|c: char| c == '\n').map(|n| s + 3 + n + 1).unwrap_or(s + 3);
        start = lang_skip;
    }
    if let Some(e_rel) = find_substring_no_case(&raw[start..], "```") {
        end = start + e_rel;
    }
    let _ = bytes; // unused, kept for clarity
    raw[start..end].to_string()
}

fn find_substring_no_case(haystack: &str, needle: &str) -> Option<usize> {
    haystack.to_lowercase().find(&needle.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnose::{Provider, QuestionResult};

    fn mk_evaluatee(label: &str) -> EvaluateeResult {
        EvaluateeResult {
            spec: format!("claude:{}", label),
            profile_label: label.to_string(),
            provider: Provider::Claude,
            results: vec![QuestionResult {
                question_id: "q1".into(),
                prompt: "test prompt".into(),
                response: "test response".into(),
                exit_code: 0,
                duration_ms: 10,
                timed_out: false,
                error: None,
            }],
            error: None,
        }
    }

    #[test]
    fn build_prompt_contains_rubric_and_questions() {
        let task = crate::diagnose::tasks::personality_task();
        let evs = vec![mk_evaluatee("ds")];
        let prompt = build_judge_prompt(&task, &evs);
        assert!(prompt.contains("## 测试："));
        assert!(prompt.contains("## 题目与评分指引"));
        assert!(prompt.contains("Agent 1: ds"));
        assert!(prompt.contains("## 总体归类指引")); // judge instructions section
    }

    #[test]
    fn parse_empty_verdict_returns_error() {
        let evs = vec![mk_evaluatee("ds")];
        let v = parse_judge_verdict("", &evs);
        assert!(v.parse_error.is_some());
        assert!(v.assessments.is_empty());
    }

    #[test]
    fn parse_verdict_with_markdown_fences() {
        let raw = "Some preamble\n```json\n{\"assessments\":[{\"profileLabel\":\"ds\",\"personalityType\":\"边界清晰型\",\"scores\":{\"服从性\":3},\"rationale\":\"because\"}]}\n```\ntail";
        let evs = vec![mk_evaluatee("ds")];
        let v = parse_judge_verdict(raw, &evs);
        assert!(v.parse_error.is_none(), "got: {:?}", v.parse_error);
        assert_eq!(v.assessments.len(), 1);
        assert_eq!(v.assessments[0].profile_label, "ds");
        assert_eq!(v.assessments[0].personality_type, "边界清晰型");
        assert_eq!(v.assessments[0].scores.get("服从性"), Some(&3));
    }

    #[test]
    fn parse_clamps_out_of_range_scores() {
        let raw = "{\"assessments\":[{\"profileLabel\":\"ds\",\"scores\":{\"服从性\":10}}]}";
        let evs = vec![mk_evaluatee("ds")];
        let v = parse_judge_verdict(raw, &evs);
        assert_eq!(v.assessments[0].scores.get("服从性"), Some(&5));
    }

    #[test]
    fn parse_falls_back_label_when_missing() {
        let raw = "{\"assessments\":[{\"personalityType\":\"x\",\"scores\":{}}]}";
        let evs = vec![mk_evaluatee("ds")];
        let v = parse_judge_verdict(raw, &evs);
        assert_eq!(v.assessments[0].profile_label, "ds");
    }

    #[test]
    fn parse_rejects_non_object() {
        let evs = vec![mk_evaluatee("ds")];
        let v = parse_judge_verdict("not even json here", &evs);
        assert!(v.parse_error.is_some());
        assert!(v.assessments.is_empty());
    }
}
