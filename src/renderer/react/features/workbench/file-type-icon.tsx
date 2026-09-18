// 工作台文件树的类型图标：VS Code/Trae 风格的彩色小徽标，纯内联 SVG，零依赖。
// 只覆盖日常最常见的类型，其余回退中性文档图标；目录用文件夹图标。

interface FileTypeIconProps {
  name: string;
  isDir?: boolean;
  /** 目录展开时换更亮的文件夹色 */
  dirOpen?: boolean;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  // ".gitignore" 这类以点开头的没有扩展名
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** 彩色圆角方块 + 缩写（TS/JS/PY 这类语言徽标） */
function Badge({ label, bg, color, fontSize }: { label: string; bg: string; color: string; fontSize?: number }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.4" y="1.4" width="13.2" height="13.2" rx="2.6" fill={bg} />
      <text
        x="8"
        y="8.15"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSize ?? (label.length > 1 ? 6.1 : 8.6)}
        fontWeight={700}
        fontFamily="Consolas, 'Courier New', monospace"
        fill={color}
      >
        {label}
      </text>
    </svg>
  );
}

/** 透明底彩色字符（{} / <> / # 这类） */
function Glyph({ label, color, fontSize }: { label: string; color: string; fontSize?: number }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <text
        x="8"
        y="8.1"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSize ?? 7.4}
        fontWeight={700}
        fontFamily="Consolas, 'Courier New', monospace"
        fill={color}
      >
        {label}
      </text>
    </svg>
  );
}

/** React 的原子图标（tsx/jsx） */
function ReactAtom() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <g stroke="#5cc7e0" strokeWidth="0.9" fill="none">
        <circle cx="8" cy="8" r="1.4" fill="#5cc7e0" stroke="none" />
        <ellipse cx="8" cy="8" rx="6.6" ry="2.6" />
        <ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(60 8 8)" />
        <ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(120 8 8)" />
      </g>
    </svg>
  );
}

/** 图片文件 */
function ImageIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2.4" width="12" height="11.2" rx="1.6" fill={color} fillOpacity="0.18" stroke={color} strokeWidth="1" />
      <circle cx="5.4" cy="5.8" r="1.1" fill={color} />
      <path d="M3.2 12.4l3-3.2 2.2 2 2.2-2.6 2.4 3.2v.2H3.2z" fill={color} />
    </svg>
  );
}

/** 未知类型：折角文档 */
function DocIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.6 2h5.2L13 6.2V13a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"
        fill="none"
        stroke="#8a9099"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M8.8 2v4.2H13" fill="none" stroke="#8a9099" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon({ open }: { open?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 4.3a.6.6 0 0 1 .6-.6h3.05l1.25 1.35h6.5a.6.6 0 0 1 .6.6v.9H2z"
        fill={open ? "#d7deea" : "#b9c2cf"}
      />
      <path
        d="M2 6.6h12l-1.05 5.7a.8.8 0 0 1-.79.65H3.6a.8.8 0 0 1-.79-.66z"
        fill={open ? "#93a1b5" : "#8f9bad"}
      />
    </svg>
  );
}

export function FileTypeIcon({ name, isDir, dirOpen }: FileTypeIconProps) {
  if (isDir) return <FolderIcon open={dirOpen} />;

  switch (extOf(name)) {
    case "ts":
      return <Badge label="TS" bg="#3178c6" color="#ffffff" />;
    case "tsx":
      return <ReactAtom />;
    case "js":
    case "mjs":
    case "cjs":
      return <Badge label="JS" bg="#e8d44d" color="#2b2b2b" />;
    case "jsx":
      return <ReactAtom />;
    case "json":
    case "jsonc":
      return <Glyph label="{}" color="#d7ba7d" fontSize={7.8} />;
    case "html":
    case "htm":
    case "xml":
    case "vue":
      return <Glyph label="<>" color="#ef8b52" fontSize={7} />;
    case "css":
      return <Glyph label="#" color="#61afef" fontSize={9.4} />;
    case "scss":
    case "sass":
      return <Glyph label="#" color="#e287b6" fontSize={9.4} />;
    case "less":
      return <Glyph label="#" color="#5b9bd5" fontSize={9.4} />;
    case "md":
    case "mdx":
      return <Glyph label="M" color="#63a6e8" fontSize={9} />;
    case "sh":
    case "bash":
    case "zsh":
      return <Glyph label=">_" color="#8fd16a" fontSize={6.6} />;
    case "ps1":
      return <Badge label="PS" bg="#5a7fc7" color="#ffffff" fontSize={5.8} />;
    case "bat":
    case "cmd":
      return <Glyph label=">_" color="#c9cdd4" fontSize={6.6} />;
    case "py":
      return <Badge label="PY" bg="#4b8bbe" color="#ffffff" fontSize={5.8} />;
    case "go":
      return <Badge label="GO" bg="#29a6d3" color="#ffffff" fontSize={5.8} />;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "bmp":
    case "ico":
    case "svg":
      return <ImageIcon color="#b48fda" />;
    default:
      return <DocIcon />;
  }
}
