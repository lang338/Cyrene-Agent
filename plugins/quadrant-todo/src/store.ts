/**
 * 数据层：PluginStorage 封装的任务 CRUD（§七）。key "tasks" 单 JSON 数组；
 * PluginStorage 本身同步 fs 读写，本类读-改-写全程不夹 await，天然免并发写竞争。
 * 入参合法性由工具面（tools.ts）保证，这里只做存储与内存缓存。
 */
import type { PluginStorage } from "../../../src/plugins/api";
import type { Task } from "./types";

const STORAGE_KEY = "tasks";

export class TaskStore {
  private tasks: Task[];

  constructor(private storage: PluginStorage) {
    this.tasks = this.load();
  }

  private load(): Task[] {
    const raw = this.storage.get<Task[]>(STORAGE_KEY);
    return Array.isArray(raw) ? raw : [];
  }

  private persist(): void {
    this.storage.set(STORAGE_KEY, this.tasks);
  }

  list(): readonly Task[] {
    return this.tasks;
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  /** 追加一条（假定已完成工具面校验与结算） */
  add(task: Task): void {
    this.tasks.push(task);
    this.persist();
  }

  /** 按 id 整体替换（结算/更新后的新对象） */
  replace(task: Task): void {
    const i = this.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) {
      this.tasks[i] = task;
      this.persist();
    }
  }

  /** 纯删除；返回是否真的删了 */
  remove(id: string): boolean {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i < 0) return false;
    this.tasks.splice(i, 1);
    this.persist();
    return true;
  }
}
