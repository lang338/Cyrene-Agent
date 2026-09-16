import type { ReactNode } from "react";
import { AskUserPanel, PermissionPanel, PopQuizPanel } from "./InteractionPanel";
import { resolveComposerSlot, type ComposerInteraction } from "./run-presentation";
import type { PopQuizSubmission } from "../../../../../shared/pop-quiz";
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
  onQuizSubmit?: (submission: PopQuizSubmission) => Promise<{ ok: boolean; error?: string; graded?: unknown[] }>;
  onQuizSkip?: (quizId: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface ComposerInteractionProps extends ComposerInteractionCallbacks {
  interaction?: ComposerInteraction;
  interactionBusy?: boolean;
}

/**
 * 只有交互卡、没有输入框的版本。
 * 给"卡片不在输入框位置"的宿主用（工作台把审批卡停靠在中栏底部）；
 * 无卡片时返回 null，宿主可以直接铺在布局里。
 */
export function ComposerInteractionPanel({
  interaction,
  interactionBusy = false,
  ...callbacks
}: ComposerInteractionProps) {
  if (!interaction) return null;

  return (
    <div className="cy-composer-slot__interaction">
      {interaction.kind === "ask" && (
        <AskUserPanel
          interaction={interaction}
          disabled={interactionBusy}
          onAnswer={(answer) => callbacks.onAnswer?.(interaction.id, answer)}
          onIgnore={() => callbacks.onIgnore?.(interaction.id)}
        />
      )}
      {interaction.kind === "permission" && (
        <PermissionPanel
          interaction={interaction}
          disabled={interactionBusy}
          onDecision={(allowed) => callbacks.onPermissionDecision?.(interaction.id, allowed)}
        />
      )}
      {interaction.kind === "quiz" && (
        <PopQuizPanel
          interaction={interaction}
          disabled={interactionBusy}
          onSubmit={callbacks.onQuizSubmit}
          onSkip={callbacks.onQuizSkip}
        />
      )}
    </div>
  );
}

/** 输入框 + 交互卡同槽：卡片出现时输入框淡出，两者叠在同一位置。 */
export function ComposerSlot({
  composer,
  interaction,
  interactionBusy = false,
  ...callbacks
}: ComposerInteractionProps & { composer: ReactNode }) {
  const slot = resolveComposerSlot(interaction);

  return (
    <div className={`cy-composer-slot is-${slot}`}>
      <div className="cy-composer-slot__composer" aria-hidden={interaction ? true : undefined}>
        {composer}
      </div>
      <ComposerInteractionPanel
        interaction={interaction}
        interactionBusy={interactionBusy}
        {...callbacks}
      />
    </div>
  );
}
