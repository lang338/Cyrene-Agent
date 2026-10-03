import { useEffect, useState, type ReactNode } from "react";
import { ChevronUp } from "lucide-react";
import { useTranslation } from "../../../i18n";
import { AskUserPanel, PermissionPanel, PlanApprovalPanel, PopQuizPanel } from "./InteractionPanel";
import { resolveComposerSlot, type ComposerInteraction } from "./run-presentation";
import type { PopQuizGradedQuestion, PopQuizSubmission } from "../../../../../shared/pop-quiz";
import "./RunExperience.css";

/**
 * 交互卡的提交回调集合。
 * 抽成独立类型是为了让别的宿主（如工作台）能原样透传同一套入口，
 * 而不是各自复制一份提交逻辑。
 */
export interface ComposerInteractionCallbacks {
  onAnswer?: (interactionId: string, answer: unknown) => void;
  onIgnore?: (interactionId: string) => void;
  onPermissionDecision?: (interactionId: string, allowed: boolean) => void;
  // 判分结果的类型必须与 PopQuizPanel 的 onSubmit 一致（曾用 unknown[]，导致赋值不兼容）
  onQuizSubmit?: (submission: PopQuizSubmission) => Promise<{ ok: boolean; error?: string; graded?: PopQuizGradedQuestion[] }>;
  onQuizSkip?: (quizId: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface ComposerInteractionProps extends ComposerInteractionCallbacks {
  interaction?: ComposerInteraction;
  interactionBusy?: boolean;
  /** 折叠状态受控传入（ComposerSlot 需要同步外层样式时用）；不传则组件自持状态 */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

/**
 * 只有交互卡、没有输入框的版本。
 * 给"卡片不在输入框位置"的宿主用（工作台把审批卡停靠在中栏底部）；
 * 无卡片时返回 null，宿主可以直接铺在布局里。
 * 卡片支持收起：收起后显示一条"待处理"提示条，点开恢复。
 */
export function ComposerInteractionPanel({
  interaction,
  interactionBusy = false,
  collapsed: collapsedProp,
  onCollapsedChange,
  ...callbacks
}: ComposerInteractionProps) {
  const { t } = useTranslation();
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = collapsedProp ?? localCollapsed;
  const setCollapsed = (value: boolean) => {
    setLocalCollapsed(value);
    onCollapsedChange?.(value);
  };

  useEffect(() => {
    setLocalCollapsed(false);
    onCollapsedChange?.(false);
    // 换一张卡（id 或种类变化）时恢复展开
  }, [interaction?.id, interaction?.kind]);

  if (!interaction) return null;

  return (
    <>
      {collapsed ? (
        <button
          type="button"
          className="cy-composer-slot__collapsed"
          aria-label={t("interaction.reopenCard")}
          onClick={() => setCollapsed(false)}
        >
          <span className="cy-composer-slot__collapsed-dot" aria-hidden="true" />
          <span>{t("interaction.pendingCard")}</span>
          <ChevronUp size={15} aria-hidden="true" />
        </button>
      ) : null}
      <div className="cy-composer-slot__interaction" aria-hidden={collapsed || undefined}>
        {interaction.kind === "ask" && (
          interaction.cardMode === "plan_approval" ? (
            <PlanApprovalPanel
              interaction={interaction}
              disabled={interactionBusy}
              onCollapse={() => setCollapsed(true)}
              onAnswer={(answer) => callbacks.onAnswer?.(interaction.id, answer)}
            />
          ) : (
            <AskUserPanel
              interaction={interaction}
              disabled={interactionBusy}
              onCollapse={() => setCollapsed(true)}
              onAnswer={(answer) => callbacks.onAnswer?.(interaction.id, answer)}
              onIgnore={() => callbacks.onIgnore?.(interaction.id)}
            />
          )
        )}
        {interaction.kind === "permission" && (
          <PermissionPanel
            interaction={interaction}
            disabled={interactionBusy}
            onCollapse={() => setCollapsed(true)}
            onDecision={(allowed) => callbacks.onPermissionDecision?.(interaction.id, allowed)}
          />
        )}
        {interaction.kind === "quiz" && (
          <PopQuizPanel
            interaction={interaction}
            disabled={interactionBusy}
            onCollapse={() => setCollapsed(true)}
            onSubmit={callbacks.onQuizSubmit}
            onSkip={callbacks.onQuizSkip}
          />
        )}
      </div>
    </>
  );
}

/** 输入框 + 交互卡同槽：卡片出现时输入框淡出，两者叠在同一位置；卡片可收起成待处理提示条。 */
export function ComposerSlot({
  composer,
  ...rest
}: ComposerInteractionProps & { composer: ReactNode }) {
  const slot = resolveComposerSlot(rest.interaction);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(false);
  }, [rest.interaction?.id, rest.interaction?.kind]);

  return (
    <div className={`cy-composer-slot is-${slot}${collapsed ? " is-collapsed" : ""}`}>
      <div className="cy-composer-slot__composer" aria-hidden={rest.interaction ? true : undefined}>
        {composer}
      </div>
      <ComposerInteractionPanel
        {...rest}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
      />
    </div>
  );
}
