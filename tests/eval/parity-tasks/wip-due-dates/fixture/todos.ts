/** The todo list: a JSON file of items, read and written whole. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Todo {
  id: number;
  title: string;
  done: boolean;
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
