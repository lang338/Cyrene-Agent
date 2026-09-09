// channels/dispatcher —— 入站消息处理核心。
//
// 设计原则：
//   - 不知道任何具体平台。platform 信息只用于查找 adapter / 落日志 / 写 sessionId。
//   - 完全无副作用：UI 广播、记忆写入、sticker 推断都在外部注入的回调里完成。
//
// sessionId 生成规则：
//   `channel:<channel>:<sha256(channel:senderId).slice(0,16)>`
//   加 channel 前缀防止跨平台 ID 冲突；hash 截断 16 字符节约空间且日志脱敏。
//
// capability 降级：
//   把 OutgoingMessage 按目标渠道的 cap 翻译 —— image→text 描述 / card→markdown / sticker 跳过。
import type {
  IncomingMessage,
  OutgoingMessage,
} from "./types";
import { channelManager, type ChannelManager } from "./manager";
import { loadChannelsSettings, type ChannelsSettings } from "./settings-store";
import { appendLog, reloadLogFromDisk } from "./message-log";
import { appendHistory as appendChannelHistory, migrateHistory } from "./history-log";
import type { MobileMessageSegmentationMode } from "../../shared/preferences";
import { rememberProactiveChannelRecipient } from "./proactive-delivery";
import { createChannelRateLimiter, type ChannelRateLimiter } from "./rate-limiter";
import { createKeyedQueue, type KeyedQueue } from "./keyed-queue";
import {
  createChannelDeliveryService,
  type ChannelDeliveryService,
} from "./delivery-service";
import {
  createOutgoingComposer,
  type OutgoingComposer,
  type SynthesizeChannelTts,
} from "./outgoing-composer";
import {
  createChannelContext,
  makeSessionId,
  type BoundConversationMessageMetadata,
  type ChannelContext,
  type ChatMessage,
  type DispatchContext,
} from "./channel-context";

export {
  formatChannelUserText,
  lookupOriginalSender,
  makeSessionId,
} from "./channel-context";
export type {
  BoundConversationMessageMetadata,
  ChatMessage,
  DispatchContext,
} from "./channel-context";

const LOG = "[ChannelDispatcher]";

/** Dispatcher 配置（依赖注入）。 */
export interface DispatcherDeps {
  manager: ChannelManager;
  /** 按外部会话和绑定桌面会话串行执行；未注入时使用进程内队列。 */
  queue?: KeyedQueue;
  /** 统一渠道发送边界；未注入时基于当前渠道管理器创建。 */
  delivery?: ChannelDeliveryService;
  /** 出站消息组装器；未注入时按当前语音依赖创建。 */
  composer?: OutgoingComposer;
  /** 渠道会话上下文；未注入时复用当前历史与绑定依赖创建。 */
  context?: ChannelContext;
  /** 渲染端 chatWindow 用于镜像显示（可选） */
  getChatWindow?: () => { webContents: { isDestroyed(): boolean; send: (channel: string, ...args: unknown[]) => void }; isDestroyed(): boolean } | null;
  /** 完整 agent 调用。未注入时返回纯 echo（仅供联调）。
   *  返回 text（必填）+ sticker（可选 sticker id，由 dispatcher 解析成本地路径后纳入 OutgoingMessage.parts）。
   *  sticker 解析失败的会静默跳过（不会把坏数据塞进 parts）。 */
  buildAndRunAgent?: (msg: IncomingMessage, sessionId: string, priorMessages?: ChatMessage[]) => Promise<{ text: string; sticker: string | null }>;
  /** 读这个 sessionId 最近 N 条对话历史（按时间顺序）。不提供时不拼历史。 */
  loadRecentChannelHistory?: (sessionId: string, limit: number) => Promise<ChatMessage[]>;
  /** 记录最近见到的外部聊天，供设置页列出可绑定的来源。 */
  observeExternalChat?: (sessionId: string, msg: IncomingMessage) => void;
  /** 返回外部聊天当前绑定的桌面会话；返回 null 表示保持渠道独立上下文。 */
  resolveBoundConversationId?: (sessionId: string) => string | null;
  /** 读取绑定桌面会话最近 N 条 user/assistant 消息。 */
  loadBoundConversationHistory?: (conversationId: string, limit: number) => Promise<ChatMessage[]>;
  /** 将绑定渠道消息镜像写入桌面会话。 */
  appendBoundConversationMessage?: (
    conversationId: string,
    role: "user" | "assistant",
    content: string,
    metadata: BoundConversationMessageMetadata,
  ) => void | Promise<void>;
  /** 可选 — 把文本合成成音频。失败返回 null，dispatcher 会跳过 audio。 */
  synthesizeTts?: SynthesizeChannelTts;
  /** 可选 — 桌面端镜像广播：bot 入站/出站消息通知给 chatWindow。 */
  broadcastChat?: (event: {
    type: "bot:incoming" | "bot:outgoing";
    channel: string;
    senderId: string;
    senderName?: string;
    chatId: string;
    text: string;
    at: number;
  }) => void;
  /** 读取通用设置中与渠道发送有关的偏好。 */
  loadGeneralSettings?: () => { mobileMessageSegmentation?: MobileMessageSegmentationMode };
}

export class ChannelDispatcher {
  private settingsCache: ChannelsSettings | null = null;
  private limiterCache: ChannelRateLimiter | null = null;
  private readonly queue: KeyedQueue;
  private readonly delivery: ChannelDeliveryService;
  deps: DispatcherDeps;

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
    this.queue = deps.queue ?? createKeyedQueue({ maxPendingPerKey: 20 });
    this.delivery = deps.delivery ?? createChannelDeliveryService(deps.manager);
    reloadLogFromDisk();
  }

  /** 懒加载：channelDispatcher 是模块级单例，import 时（app ready 前）就实例化。
   *  那时 safeStorage 还不可用，提前 load 会把 enc: 字段解成空串缓存在内存里。
   *  首次真正使用（消息进来 / UI 交互）必然在 ready 之后。 */
  private get settings(): ChannelsSettings {
    if (!this.settingsCache) this.settingsCache = loadChannelsSettings();
    return this.settingsCache;
  }

  private get limiter(): ChannelRateLimiter {
    if (!this.limiterCache) {
      this.limiterCache = createChannelRateLimiter({
        limits: {
          perUser: this.settings.rateLimitPerUser,
          perChannel: this.settings.rateLimitPerChannel,
        },
      });
    }
    return this.limiterCache;
  }

  /** 重新加载 settings（UI 改了限速配置时调） */
  reloadSettings(): void {
    this.settingsCache = null;
    if (this.limiterCache) {
      this.limiterCache.reconfigure({
        perUser: this.settings.rateLimitPerUser,
        perChannel: this.settings.rateLimitPerChannel,
      });
    }
  }

  /**
   * 处理一条入站消息。这是 manager 注入到 adapter.onMessage 的回调。
   *
   * 流程：限速 → 计算 sessionId → 加载历史滑窗 → 本条落历史 → 调 buildAndRunAgent →
   * 构造 OutgoingMessage。如果没注入 buildAndRunAgent，返回 echo 作为占位（仅供联调）。
   */
  async handleIncoming(msg: IncomingMessage): Promise<OutgoingMessage | null> {
    const sessionId = makeSessionId(msg.channel, msg.chatId);
    const contextService = this.createContextService();
    return this.queue.run(`external:${sessionId}`, async () => {
      if (!this.limiter.tryConsume(msg.channel, msg.senderId)) {
        console.warn(LOG, `限速: ${msg.channel}:${msg.senderId}`);
        return null;
      }

      try {
        this.deps.observeExternalChat?.(sessionId, msg);
      } catch (err) {
        console.warn(LOG, "observeExternalChat 失败（继续处理消息）:", err);
      }

      const context = contextService.resolveDispatchContext(sessionId);
      const execute = () => this.processIncoming(msg, context, contextService);
      return context.boundConversationId
        ? this.queue.run(`conversation:${context.boundConversationId}`, execute)
        : execute();
    });
  }

  /** 按当前注入函数创建本条消息使用的上下文服务。 */
  private createContextService(): ChannelContext {
    return this.deps.context ?? createChannelContext({
      resolveBoundConversationId: this.deps.resolveBoundConversationId,
      loadRecentChannelHistory: this.deps.loadRecentChannelHistory,
      loadBoundConversationHistory: this.deps.loadBoundConversationHistory,
      appendChannelHistory,
      appendBoundConversationMessage: this.deps.appendBoundConversationMessage,
      migrateHistory,
    });
  }

  private async processIncoming(
    msg: IncomingMessage,
    context: DispatchContext,
    contextService: ChannelContext,
  ): Promise<OutgoingMessage | null> {
    const { sessionId } = context;
    // 绑定只选择历史与消息镜像目标，Agent 运行身份始终属于原渠道。
    contextService.recordIncomingSession(msg, context);
    rememberProactiveChannelRecipient(msg, sessionId);

    // 入站消息广播到桌面端 chatWindow（让用户看到 bot 在和谁聊天）
    if (this.settings.mirrorToDesktop) {
      try {
        this.deps.broadcastChat?.({
          type: "bot:incoming",
          channel: msg.channel,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatId: msg.chatId,
          text: msg.text,
          at: msg.at.getTime(),
        });
      } catch (err) {
        console.warn(LOG, "broadcastChat (incoming) 失败:", err);
      }
    }

    // 入站消息写日志
    try {
      appendLog({
        dir: "incoming",
        channel: msg.channel,
        senderId: msg.senderId,
        senderName: msg.senderName,
        chatId: msg.chatId,
        text: msg.text,
        hasAttachments: (msg.attachments?.length ?? 0) > 0,
      });
    } catch (err) {
      console.warn(LOG, "appendLog (incoming) 失败:", err);
    }

    // 先加载历史滑窗（此时还不含本条），再落本条入站消息。
    // 顺序不能反：先 append 再 load 会让本条消息既出现在滑窗末尾、又作为新 user
    // 消息追加给 agent，模型会把同一条消息读两遍。
    let priorMessages: ChatMessage[] | undefined;
    if (this.deps.buildAndRunAgent) {
      priorMessages = await contextService.resolvePriorMessages(context, 16);
    }

    // 入站消息落对话历史（下一轮滑窗的数据源）
    await contextService.appendIncomingContext(msg, context);

    // agent 调用；未注入 → echo
    let replyText: string;
    let sticker: string | null = null;
    if (this.deps.buildAndRunAgent) {
      // 拼接最近 16 条历史（同桌面端 buildModelMessages 行为）。
      // 加载失败/未注入 → 不拼历史（兼容旧实现）。
      try {
        const result = await this.deps.buildAndRunAgent(msg, sessionId, priorMessages);
        replyText = result.text;
        sticker = result.sticker;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(LOG, "agent 调用失败:", errMsg);
        // 失败落盘：打包版看不到主进程 console，不留文件就只能靠猜"看得到消息为什么不回复"
        try {
          appendLog({
            dir: "error",
            channel: msg.channel,
            senderId: msg.senderId,
            senderName: msg.senderName,
            chatId: msg.chatId,
            text: `[agent 调用失败] ${errMsg}`,
          });
        } catch (logErr) {
          console.warn(LOG, "appendLog (error) 失败:", logErr);
        }
        return null;
      }
    } else {
      replyText = `[echo][${msg.channel}][${msg.senderId}] ${msg.text}`;
      console.log(LOG, "echo (无 buildAndRunAgent):", replyText);
    }

    const capability = this.deps.manager.getAdapter(msg.channel)?.capability;
    const composer = this.deps.composer ?? createOutgoingComposer({
      synthesizeTts: this.deps.synthesizeTts,
    });
    const prepared = await composer.compose({
      incoming: msg,
      replyText,
      sticker,
      capability,
      settings: {
        ttsEnabled: this.settings.ttsEnabled,
        stickerEnabled: this.settings.stickerEnabled,
      },
      mobileMessageSegmentation: this.deps.loadGeneralSettings?.().mobileMessageSegmentation,
    });

    try {
      const deliveryResult = await this.delivery.send(prepared.message);
      if (!deliveryResult.ok) {
        console.warn(LOG, `发送失败 [${msg.channel}]:`, deliveryResult.error);
        try {
          appendLog({
            dir: "error",
            channel: msg.channel,
            senderId: msg.senderId,
            senderName: msg.senderName,
            chatId: msg.chatId,
            text: `[发送失败] ${deliveryResult.error}`,
          });
        } catch (err) {
          console.warn(LOG, "appendLog (delivery error) 失败:", err);
        }
        return null;
      }

      // 出站消息广播到桌面端
      if (this.settings.mirrorToDesktop) {
        try {
          this.deps.broadcastChat?.({
            type: "bot:outgoing",
            channel: msg.channel,
            senderId: msg.senderId,
            senderName: msg.senderName,
            chatId: msg.chatId,
            text: prepared.assistantText,
            at: Date.now(),
          });
        } catch (err) {
          console.warn(LOG, "broadcastChat (outgoing) 失败:", err);
        }
      }

      // 出站消息写日志（仅文本片段，附件路径不写入日志）
      try {
        appendLog({
          dir: "outgoing",
          channel: msg.channel,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatId: msg.chatId,
          text: prepared.assistantText,
          hasAttachments: prepared.message.parts.some((part) => part.kind === "audio"),
        });
      } catch (err) {
        console.warn(LOG, "appendLog (outgoing) 失败:", err);
      }

      // 助手上下文只在渠道确认发送成功后提交。
      await contextService.appendAssistantContext(msg, context, prepared);

      return prepared.message;
    } finally {
      try {
        await composer.cleanupTransientFiles(prepared.transientFiles);
      } catch (err) {
        console.warn(LOG, "清理出站临时文件失败:", err);
      }
    }
  }
}

/** 进程级单例 —— 注入 buildAndRunAgent 后才会真正干活。 */
export const channelDispatcher = new ChannelDispatcher({
  manager: channelManager,
});

/** 给 index.ts 调：注入 buildAndRunAgent（让 dispatcher 真正跑 agent）
 *  返回 text + sticker：text 直接做 reply；sticker 由 dispatcher 解析成本地路径后纳入 OutgoingMessage.parts。 */
export function setDispatcherBuildAndRunAgent(
  fn: (msg: IncomingMessage, sessionId: string, priorMessages?: ChatMessage[]) => Promise<{ text: string; sticker: string | null }>,
): void {
  channelDispatcher.deps.buildAndRunAgent = fn;
}

/** 注入 TTS 合成（返回音频或 null） */
export function setDispatcherSynthesizeTts(
  fn: SynthesizeChannelTts,
): void {
  channelDispatcher.deps.synthesizeTts = fn;
}

/** 注入最近对话历史读取（index.ts 注入一个用 history-log 实现的闭包） */
export function setDispatcherLoadRecentHistory(
  fn: (sessionId: string, limit: number) => Promise<{ role: "user" | "assistant"; content?: string }[]>,
): void {
  channelDispatcher.deps.loadRecentChannelHistory = fn;
}

/** 注入最近外部聊天观察器（用于设置页上下文绑定列表）。 */
export function setDispatcherObserveExternalChat(
  fn: (sessionId: string, msg: IncomingMessage) => void,
): void {
  channelDispatcher.deps.observeExternalChat = fn;
}

/** 注入外部聊天到桌面会话的绑定查询。 */
export function setDispatcherResolveBoundConversation(
  fn: (sessionId: string) => string | null,
): void {
  channelDispatcher.deps.resolveBoundConversationId = fn;
}

/** 注入绑定桌面会话历史读取器。 */
export function setDispatcherLoadBoundConversationHistory(
  fn: (conversationId: string, limit: number) => Promise<{ role: "user" | "assistant"; content?: string }[]>,
): void {
  channelDispatcher.deps.loadBoundConversationHistory = fn;
}

/** 注入绑定桌面会话消息写入器。 */
export function setDispatcherAppendBoundConversationMessage(
  fn: (
    conversationId: string,
    role: "user" | "assistant",
    content: string,
    metadata: BoundConversationMessageMetadata,
  ) => void | Promise<void>,
): void {
  channelDispatcher.deps.appendBoundConversationMessage = fn;
}

/** 注入桌面端镜像广播（chatWindow 推送 bot 入站/出站消息） */
export function setDispatcherBroadcastChat(
  fn: (event: {
    type: "bot:incoming" | "bot:outgoing";
    channel: string;
    senderId: string;
    senderName?: string;
    chatId: string;
    text: string;
    at: number;
  }) => void,
): void {
  channelDispatcher.deps.broadcastChat = fn;
}

/** 注入通用设置读取器（渠道发送时实时读取偏好）。 */
export function setDispatcherLoadGeneralSettings(
  fn: () => { mobileMessageSegmentation?: MobileMessageSegmentationMode },
): void {
  channelDispatcher.deps.loadGeneralSettings = fn;
}
