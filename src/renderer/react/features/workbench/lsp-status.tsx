// 语言智能的状态说明：**只在"语义能力变弱"时出现**，并给一个能立刻修好的动作。
//
// 背景：语义补全依赖两件事——① 这个工作区能拿到语言服务；② 项目里有 tsconfig/jsconfig。
// 少任何一样，补全与跳转就退化成"文本级"。**不说明的话，用户只会觉得"工作台的补全做得很烂"**，
// 而不是"我这里缺配置"——所以这里把原因摆出来，并给一个动作：
// - 没装语言服务：能应用内装的（pyright）直接给"下载并启用"，其余给安装指引；
// - 装了服务但缺项目配置：只有 TS/JS 才谈 tsconfig（别的语言要么不需要，要么清单得用户自己建）。
//
// 参照同类软件：VS Code 的语言状态项（常驻入口 + 点开详情）、IDEA 的 banner + 一键修复。
// 我们做成"一行常驻 banner"：结论 + 原因 + 安装指引直接可见（不藏在点击后面）；
// 只有推荐配置的具体内容才折叠（点"生成推荐配置"后就地展开预览）。一切正常时**不渲染任何东西**。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../i18n";
import type { WorkbenchLspEnv, WorkbenchLspInstallProgress } from "../../../../shared/code-workbench-types";
import { isLspLanguage } from "../../../../shared/workbench-languages";
import { workbenchApi } from "./WorkspaceTree";

export interface WorkbenchLspStatusProps {
  sessionId: string;
  /** 当前打开的文件（工作区相对路径；工作区外是绝对路径） */
  activePath: string | null;
  /** 文件内容已就绪；没就绪时不查，免得基于半截状态给结论 */
  fileReady: boolean;
  /** Monaco languageId：决定"缺配置"这一态要不要提 tsconfig */
  language: string | null;
  /** 工作区外的文件不属于任何项目，不参与 */
  external: boolean;
}

/** 字节数转成人看的大小；只用于按钮/进度这类一眼扫过的文案 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const megabytes = bytes / 1024 / 1024;
    return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function WorkbenchLspStatus({ sessionId, activePath, fileReady, language, external }: WorkbenchLspStatusProps) {
  const { t } = useTranslation();
  const [env, setEnv] = useState<WorkbenchLspEnv | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState<string | null>(null);
  /** 正在下载的服务 id；null = 没有安装在进行 */
  const [installingServerId, setInstallingServerId] = useState<string | null>(null);
  const [progress, setProgress] = useState<WorkbenchLspInstallProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  // tsconfig 是 TypeScript 独有的概念：Python/YAML 这类不需要项目配置，Go/Rust/Java 的
  // go.mod/Cargo.toml/pom.xml 是语言本身的必需品、得用户按项目自己建（帮不上也不该代劳）。
  // 所以"缺配置就帮你生成一份"只对 TS/JS 成立，其余语言只看"服务装没装"。
  const configurable = language === "typescript" || language === "javascript";

  useEffect(() => {
    setEnv(null);
    setDismissed(false);
    setShowPreview(false);
    setWritten(null);
    setInstallError(null);
    if (!activePath || external || !fileReady) return;
    const api = workbenchApi();
    if (!api?.lspEnv) return;
    let cancelled = false;
    void api
      .lspEnv(sessionId, activePath)
      .then((next) => {
        if (!cancelled) setEnv(next ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId, activePath, external, fileReady, refreshToken]);

  // 订阅安装进度。只认自己发起的那一次：别的窗口正在装别的服务，不该改这条提示。
  useEffect(() => {
    const api = workbenchApi();
    if (!api?.onLspInstallProgress || !installingServerId) return;
    return api.onLspInstallProgress((payload) => {
      if (payload.serverId === installingServerId) setProgress(payload);
    });
  }, [installingServerId]);

  const writeConfig = useCallback(async () => {
    const api = workbenchApi();
    if (!api?.writeFile || !env) return;
    setWriting(true);
    try {
      await api.writeFile(sessionId, env.configRelativePath, env.recommendedConfig);
      setWritten(env.configRelativePath);
      setShowPreview(false);
      // 写完重新问一次：配置有了，提示自己就会消失
      setRefreshToken((token) => token + 1);
    } catch {
      // 写失败就保持现状：不弹错、不再打扰，用户可重试
    } finally {
      setWriting(false);
    }
  }, [env, sessionId]);

  const startInstall = useCallback(async () => {
    const api = workbenchApi();
    const serverId = env?.serverId;
    if (!api?.installLspServer || !serverId) return;
    setInstallError(null);
    setProgress(null);
    setInstallingServerId(serverId);
    try {
      const result = await api.installLspServer(serverId);
      if (!result.ok) {
        // 取消是用户自己的选择，安静回到"未安装"，不报错
        if (!result.cancelled) setInstallError(result.error);
        return;
      }
      // 装好了：重新问一次环境，服务能起来的话整条提示自己就会消失
      setRefreshToken((token) => token + 1);
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingServerId(null);
      setProgress(null);
    }
  }, [env?.serverId]);

  const cancelInstall = useCallback(() => {
    const api = workbenchApi();
    if (api?.cancelLspInstall && env?.serverId) void api.cancelLspInstall(env.serverId);
  }, [env?.serverId]);

  // 两道闸门都要过：
  // - isLspLanguage(language)：这个语言上真的注册了 provider，装了服务就能用（否则提示等于骗人，
  //   比如 .vue 在 catalog 里有服务但我们还没接）；
  // - env.serverId：这类文件确实有对应的语言服务定义，提示才有具体内容（装什么）。
  const status: "no-service" | "no-config" | null = !env || !env.serverId || !isLspLanguage(language)
    ? null
    : !env.hasService
      ? "no-service"
      : configurable && !env.configFile
        ? "no-config"
        : null;

  // 安装指引优先用本地化文案（key 按 serverId 命名）；还没翻译的新服务退回主进程那句中文
  const installHintKey = env?.serverId ? `workbench.lspInstallHints.${env.serverId}` : "";
  const localizedHint = installHintKey ? t(installHintKey) : "";
  const installHint = env && localizedHint && localizedHint !== installHintKey
    ? localizedHint
    : env?.installHint ?? "";

  // 用户主动关掉后，本文件会话内不再打扰（切换文件时 effect 会把 dismissed 重置）；
  // written 是写入成功后的独立确认条，不受 dismissed 影响
  if (!status || dismissed) {
    return written ? (
      <div className="cy-workbench__lsp cy-workbench__lsp--ok">✓ {t("workbench.lspConfigWritten", { path: written })}</div>
    ) : null;
  }

  const install = env?.install ?? null;
  const installing = installingServerId !== null;
  const progressText = progress?.phase === "extract"
    ? t("workbench.lspInstallExtracting")
    : progress && progress.totalBytes > 0
      ? t("workbench.lspInstallDownloading", {
          percent: Math.floor((progress.receivedBytes / progress.totalBytes) * 100),
          done: formatSize(progress.receivedBytes),
          total: formatSize(progress.totalBytes),
        })
      : t("workbench.lspInstallStarting");

  return (
    <div className="cy-workbench__lsp">
      <div className="cy-workbench__lsp-bar">
        <span className="cy-workbench__lsp-text">
          <strong>{status === "no-service" ? t("workbench.lspStatusNoService") : t("workbench.lspStatusNoConfig")}</strong>
          {status === "no-service" ? t("workbench.lspNoServiceNotice") : t("workbench.lspNoConfigNotice")}
        </span>
        <div className="cy-workbench__lsp-actions">
          {status === "no-config" && env && (
            <button
              type="button"
              className="cy-workbench__lsp-btn cy-workbench__lsp-btn--primary"
              onClick={() => setShowPreview((value) => !value)}
            >
              {t("workbench.lspGenerateConfig")}
            </button>
          )}
          {/* 能应用内装就直接给按钮：这是"不用开终端、不用知道 npm"的那条路 */}
          {status === "no-service" && install && !installing && (
            <button
              type="button"
              className="cy-workbench__lsp-btn cy-workbench__lsp-btn--primary"
              onClick={() => void startInstall()}
            >
              {t("workbench.lspInstallServer", { size: formatSize(install.sizeBytes) })}
            </button>
          )}
          {installing && (
            <button type="button" className="cy-workbench__lsp-btn" onClick={cancelInstall}>
              {t("workbench.lspInstallCancel")}
            </button>
          )}
          <button
            type="button"
            className="cy-workbench__lsp-close"
            onClick={() => {
              setDismissed(true);
              setShowPreview(false);
            }}
            title={t("workbench.dismissNotice")}
            aria-label={t("workbench.dismissNotice")}
          >
            ×
          </button>
        </div>
      </div>

      {/* 下面这一行常驻可见（不走"点开才看得到"）：下载进度 / 失败原因+备选装法 / 手动安装指引 */}
      {status === "no-service" && installing && <div className="cy-workbench__lsp-detail">{progressText}</div>}
      {status === "no-service" && !installing && installError && (
        <div className="cy-workbench__lsp-detail is-error">
          {t("workbench.lspInstallFailed", { error: installError })}
          {installHint ? ` ${installHint}` : ""}
        </div>
      )}
      {status === "no-service" && !installing && !installError && !install && installHint && (
        <div className="cy-workbench__lsp-detail">{installHint}</div>
      )}

      {showPreview && env && (
        <div className="cy-workbench__lsp-preview">
          <div className="cy-workbench__lsp-preview-hint">
            {t("workbench.lspConfigPreviewHint", { path: env.configRelativePath })}
          </div>
          <pre className="cy-workbench__lsp-preview-code">{env.recommendedConfig}</pre>
          <div className="cy-workbench__lsp-preview-actions">
            <button
              type="button"
              className="cy-workbench__lsp-btn cy-workbench__lsp-btn--primary"
              onClick={() => void writeConfig()}
              disabled={writing}
            >
              {t("workbench.lspWriteConfig")}
            </button>
            <button type="button" className="cy-workbench__lsp-btn" onClick={() => setShowPreview(false)} disabled={writing}>
              {t("workbench.lspCancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
