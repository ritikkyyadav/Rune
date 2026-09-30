/** The todo list: a JSON file of items, read and written whole. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Todo {
  id: number;
  title: string;
  done: boolean;
  /** The day it is due, written YYYY-MM-DD. */
  due?: string;
}

export function load(path: string): Todo[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Todo[]) : [];
}

export function save(path: string, todos: Todo[]): void {
  writeFileSync(path, `${JSON.stringify(todos, null, 2)}\n`);
}

export function addTodo(todos: Todo[], title: string): Todo {
  const id = todos.reduce((max, todo) => Math.max(max, todo.id), 0) + 1;
  const todo: Todo = { id, title, done: false };
  todos.push(todo);
  return todo;
}

export function completeTodo(todos: Todo[], id: number): Todo {
  const todo = todos.find((item) => item.id === id);
  if (!todo) throw new Error(`no todo with id ${id}`);
  todo.done = true;
  return todo;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Give a todo a due date. `date` must be a real calendar day written
 * YYYY-MM-DD: 2026-02-30 is refused, not rolled over into March.
 */
export function setDue(todos: Todo[], id: number, date: string): Todo {
  const parts = ISO_DAY.exec(date);
  const day = parts
    ? new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])))
    : undefined;
  if (!day || day.toISOString().slice(0, 10) !== date)
    throw new Error(`not a date: ${date} (expected YYYY-MM-DD)`);
  const todo = todos.find((item) => item.id === id);
  if (!todo) throw new Error(`no todo with id ${id}`);
  todo.due = date;
  return todo;
}
