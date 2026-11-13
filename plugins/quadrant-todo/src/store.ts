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

  /**
   * 落盘成功后才更新内存缓存（CodeRabbit 评审）：若 set 抛错（磁盘满/权限），
   * 内存态与存储态保持一致，不会出现"未成功登记的任务滞留缓存、被后续写入
   * 顺带持久化"的错位。
   */

  list(): readonly Task[] {
    return this.tasks;
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  /** 追加一条（假定已完成工具面校验与结算） */
  add(task: Task): void {
    const next = [...this.tasks, task];
    this.storage.set(STORAGE_KEY, next);
    this.tasks = next;
  }

  /** 按 id 整体替换（结算/更新后的新对象） */
  replace(task: Task): void {
    if (!this.tasks.some((t) => t.id === task.id)) return;
    const next = this.tasks.map((t) => (t.id === task.id ? task : t));
    this.storage.set(STORAGE_KEY, next);
    this.tasks = next;
  }

  /** 纯删除；返回是否真的删了 */
  remove(id: string): boolean {
    if (!this.tasks.some((t) => t.id === id)) return false;
    const next = this.tasks.filter((t) => t.id !== id);
    this.storage.set(STORAGE_KEY, next);
    this.tasks = next;
    return true;
  }
}
