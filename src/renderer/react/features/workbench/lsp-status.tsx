// 语言智能的状态说明：**只在"语义能力变弱"时出现**，并给一个能立刻修好的动作。
//
// 背景：语义补全依赖两件事——① 这个工作区能拿到语言服务；② 项目里有 tsconfig/jsconfig。
// 少任何一样，补全与跳转就退化成"文本级"。**不说明的话，用户只会觉得"工作台的补全做得很烂"**，
// 而不是"我这里缺配置"——所以这里把原因摆出来，并给一个"生成推荐配置"的动作。
//
// 参照同类软件：VS Code 的语言状态项（常驻入口 + 点开详情）、IDEA 的 banner + 一键修复。
// 我们做成"一行常驻 banner"：结论 + 原因直接可见（不藏在点击后面），右侧一键修复按钮；
// 只有推荐配置的具体内容才折叠（点"生成推荐配置"后就地展开预览）。一切正常时**不渲染任何东西**。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../i18n";
import type { WorkbenchLspEnv } from "../../../../shared/code-workbench-types";
import { workbenchApi } from "./WorkspaceTree";

export interface WorkbenchLspStatusProps {
  sessionId: string;
  /** 当前打开的文件（工作区相对路径；工作区外是绝对路径） */
  activePath: string | null;
  /** 文件内容已就绪；没就绪时不查，免得基于半截状态给结论 */
  fileReady: boolean;
  /** Monaco languageId：只对 TS/JS 说这套话（其余语言本来就没接语义补全） */
  language: string | null;
  /** 工作区外的文件不属于任何项目，不参与 */
  external: boolean;
}

export function WorkbenchLspStatus({ sessionId, activePath, fileReady, language, external }: WorkbenchLspStatusProps) {
  const { t } = useTranslation();
  const [env, setEnv] = useState<WorkbenchLspEnv | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState<string | null>(null);

  const supported = language === "typescript" || language === "javascript";

  useEffect(() => {
    setEnv(null);
    setDismissed(false);
    setShowPreview(false);
    setWritten(null);
    if (!activePath || external || !fileReady || !supported) return;
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
  }, [sessionId, activePath, external, fileReady, supported, refreshToken]);

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

  const status: "no-service" | "no-config" | null = !env
    ? null
    : !env.hasService
      ? "no-service"
      : !env.configFile
        ? "no-config"
        : null;

  // 用户主动关掉后，本文件会话内不再打扰（切换文件时 effect 会把 dismissed 重置）；
  // written 是写入成功后的独立确认条，不受 dismissed 影响
  if (!status || dismissed) {
    return written ? (
      <div className="cy-workbench__lsp cy-workbench__lsp--ok">✓ {t("workbench.lspConfigWritten", { path: written })}</div>
    ) : null;
  }

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
