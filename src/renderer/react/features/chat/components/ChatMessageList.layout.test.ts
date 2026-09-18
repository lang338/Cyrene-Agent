import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(__dirname, "ChatMessageList.css"), "utf8");
const component = readFileSync(resolve(__dirname, "ChatMessageList.tsx"), "utf8");

describe("chat full-width assistant replies", () => {
  it("renders no avatar for the assistant role", () => {
    expect(component).not.toContain("CyreneMessageAvatar");
    expect(component).toMatch(/assistant: \{[\s\S]*?avatar: null/);
  });

  it("lets answers and run activity use the full chat width", () => {
    expect(stylesheet).not.toContain("--cy-message-reading-width");
    expect(stylesheet).toMatch(/\.cy-message--assistant \.ant-bubble-body \{[\s\S]*max-width: 100%/);
    expect(stylesheet).toMatch(/\.cy-message--activity \{[\s\S]*width: 100%[\s\S]*max-width: none/);
  });

  it("removes the antd-x 15% end gap for cyrene-side messages but keeps it for users", () => {
    expect(stylesheet).toMatch(
      /\.ant-bubble-start\.cy-message:not\(\.ant-bubble-divider\):not\(\.ant-bubble-system\) \{\s*padding-inline-end: 0;\s*\}/,
    );
    expect(stylesheet).not.toMatch(/ant-bubble-end[^{]*\{[\s\S]*padding-inline-start: 0/);
  });

  it("does not reserve avatar space when assistant bubbles are disabled", () => {
    expect(stylesheet).not.toContain("calc(100% - 54px)");
  });
});
