/**
 * todo: a small todo list on disk.
 *
 *   bun cli.ts add <title>   add a todo
 *   bun cli.ts done <id>     mark one done
 *   bun cli.ts list          show them all
 *
 * The list lives in $TODO_FILE, or todos.json in the current directory.
 */

import { addTodo, completeTodo, load, save, type Todo } from "./todos";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export const USAGE = "usage: bun cli.ts add <title> | done <id> | list\n";

export function render(todo: Todo): string {
  return `${todo.done ? "[x]" : "[ ]"} ${todo.id}. ${todo.title}`;
}

/** Run one command against the list saved in `file`. */
export function run(args: string[], file: string): Result {
  const [command, ...rest] = args;
  const todos = load(file);
  try {
    switch (command) {
      case "add": {
        const title = rest.join(" ").trim();
        if (!title) return { code: 2, stdout: "", stderr: USAGE };
        const todo = addTodo(todos, title);
        save(file, todos);
        return { code: 0, stdout: `added ${todo.id}\n`, stderr: "" };
      }
      case "done": {
        const todo = completeTodo(todos, Number(rest[0]));
        save(file, todos);
        return { code: 0, stdout: `done ${todo.id}\n`, stderr: "" };
      }
      case "list":
        return { code: 0, stdout: todos.map((todo) => `${render(todo)}\n`).join(""), stderr: "" };
      default:
        return { code: 2, stdout: "", stderr: USAGE };
    }
  } catch (error) {
    return { code: 1, stdout: "", stderr: `${(error as Error).message}\n` };
  }
}

if (import.meta.main) {
  const result = run(process.argv.slice(2), process.env.TODO_FILE ?? "todos.json");
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
