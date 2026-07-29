import assert from "node:assert/strict";
import test from "node:test";

import {
  selectedTreeEntry,
  treePickerFromResponse,
  visibleTreeEntries,
} from "../lib/tui/tree-picker.js";

test("normalizes Pi SessionManager tree nodes and marks the active path", () => {
  const normalized = treePickerFromResponse({
    leafId: "active-leaf",
    tree: [{
      entry: {
        id: "root",
        parentId: null,
        type: "message",
        message: { role: "user", content: "start here" },
      },
      label: "checkpoint",
      children: [
        {
          entry: {
            id: "active-leaf",
            parentId: "root",
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "active answer" }] },
          },
          children: [],
        },
        {
          entry: {
            id: "other-leaf",
            parentId: "root",
            type: "branch_summary",
            summary: "other branch",
          },
          children: [],
        },
      ],
    }],
  });

  assert.deepEqual(normalized.entries.map(({ id }) => id), ["root", "active-leaf", "other-leaf"]);
  assert.equal(normalized.entries[0].label, "checkpoint");
  assert.equal(normalized.entries[0].onActivePath, true);
  assert.equal(normalized.entries[1].current, true);
  assert.equal(normalized.entries[2].onActivePath, false);
  assert.match(normalized.entries[1].text, /assistant: active answer/);
  assert.match(normalized.entries[2].text, /branch summary.*other branch/);
});

test("filters and selects tree entries without changing Pi entry IDs", () => {
  const picker = {
    ...treePickerFromResponse({
      leafId: "b",
      tree: [
        {
          entry: { id: "a", parentId: null, type: "model_change", modelId: "glm-5.2" },
          children: [],
        },
        {
          entry: { id: "b", parentId: null, type: "thinking_level_change", thinkingLevel: "high" },
          children: [],
        },
      ],
    }),
    query: "thinking",
    selected: 0,
    stage: "tree",
    summarySelected: 0,
    customPrompt: "",
    working: false,
  };

  assert.deepEqual(visibleTreeEntries(picker).map(({ id }) => id), ["b"]);
  assert.equal(selectedTreeEntry(picker)?.id, "b");
});
