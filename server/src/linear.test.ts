import { test } from "node:test";
import assert from "node:assert/strict";
import { sortByPriorityAndDue, type Issue } from "./linear.ts";

function issue(identifier: string, priority: number, dueDate: string | null = null): Issue {
  return { id: identifier, identifier, title: identifier, description: null, priority, dueDate, state: null };
}

test("urgent before low priority regardless of input order", () => {
  const sorted = sortByPriorityAndDue([issue("A", 4), issue("B", 1), issue("C", 2)]);
  assert.deepEqual(sorted.map((i) => i.identifier), ["B", "C", "A"]);
});

test("no-priority (0) sorts last, after low priority (4)", () => {
  const sorted = sortByPriorityAndDue([issue("A", 0), issue("B", 4)]);
  assert.deepEqual(sorted.map((i) => i.identifier), ["B", "A"]);
});

test("same priority breaks tie by earlier due date first", () => {
  const sorted = sortByPriorityAndDue([issue("A", 2, "2026-11-01"), issue("B", 2, "2026-10-20")]);
  assert.deepEqual(sorted.map((i) => i.identifier), ["B", "A"]);
});

test("same priority, due date beats no due date", () => {
  const sorted = sortByPriorityAndDue([issue("A", 2, null), issue("B", 2, "2026-10-20")]);
  assert.deepEqual(sorted.map((i) => i.identifier), ["B", "A"]);
});

test("does not mutate the input array", () => {
  const input = [issue("A", 4), issue("B", 1)];
  sortByPriorityAndDue(input);
  assert.deepEqual(input.map((i) => i.identifier), ["A", "B"]);
});
