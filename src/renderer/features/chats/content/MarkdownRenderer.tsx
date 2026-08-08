import { AlertCircle, Code2, Image as ImageIcon, Table2 } from "lucide-react";
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  type Components,
  type ExtraProps,
} from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Element, Root, RootContent } from "hast";

import { CopyButton } from "../components/CopyButton";
import styles from "./MarkdownRenderer.module.css";
import "katex/dist/katex.min.css";

type MarkdownElementProps<Tag extends keyof React.JSX.IntrinsicElements> =
  React.JSX.IntrinsicElements[Tag] & ExtraProps;

const MarkdownSourceContext = createContext("");

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.["code"] ?? []),
      [
        "className",
        /^language-[A-Za-z0-9_-]+$/u,
        "math-inline",
        "math-display",
      ],
    ],
    div: [
      ...(defaultSchema.attributes?.["div"] ?? []),
      ["className", "math", "math-display", "charamate-math-source"],
      "dataMathDisplay",
      "dataMathSource",
    ],
    span: [
      ...(defaultSchema.attributes?.["span"] ?? []),
      ["className", "math", "math-inline", "charamate-math-source"],
      "dataMathDisplay",
      "dataMathSource",
    ],
  },
};

function hastText(node: Root | RootContent): string {
  if (node.type === "text") {
    return node.value;
  }
  if (!("children" in node)) {
    return "";
  }
  let value = "";
  for (const child of node.children) {
    value += hastText(child);
  }
  return value;
}

function wrapMathChildren(parent: Element | Root): void {
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index];
    if (child?.type !== "element") {
      continue;
    }
    const preChild = child.tagName === "pre" ? child.children[0] : undefined;
    const preChildClasses =
      preChild?.type === "element" &&
      Array.isArray(preChild.properties.className)
        ? preChild.properties.className
        : [];
    if (
      preChild?.type === "element" &&
      preChild.tagName === "code" &&
      preChildClasses.includes("language-math")
    ) {
      parent.children[index] = {
        children: [child],
        position: child.position,
        properties: {
          className: ["charamate-math-source"],
          dataMathDisplay: "true",
          dataMathSource: hastText(preChild),
        },
        tagName: "div",
        type: "element",
      };
      continue;
    }
    const classes = Array.isArray(child.properties.className)
      ? child.properties.className
      : [];
    const display = classes.includes("math-display");
    const inline = classes.includes("math-inline");
    if (display || inline) {
      parent.children[index] = {
        children: [child],
        position: child.position,
        properties: {
          className: ["charamate-math-source"],
          dataMathDisplay: display ? "true" : "false",
          dataMathSource: hastText(child),
        },
        tagName: display ? "div" : "span",
        type: "element",
      };
      continue;
    }
    wrapMathChildren(child);
  }
}

function rehypeMathSource() {
  return (tree: Root) => {
    wrapMathChildren(tree);
  };
}

function sourceForNode(source: string, node: ExtraProps["node"]): string {
  const start = node?.position?.start?.offset;
  const end = node?.position?.end?.offset;
  return start === undefined || end === undefined
    ? ""
    : source.slice(start, end);
}

function mathSourceForNode(node: ExtraProps["node"]): string {
  const value = node?.properties["dataMathSource"];
  return typeof value === "string" ? value : "";
}

function MathSpan({
  children,
  className,
  node,
  ...props
}: MarkdownElementProps<"span">) {
  const mathSource = mathSourceForNode(node);
  if (!mathSource) {
    return (
      <span className={className} {...props}>
        {children}
      </span>
    );
  }

  return (
    <span className={`${className ?? ""} ${styles["mathInline"]}`} {...props}>
      {children}
      <span className={styles["mathCopy"]}>
        <CopyButton label="复制 TeX" value={mathSource} />
      </span>
    </span>
  );
}

function MathDiv({
  children,
  className,
  node,
  ...props
}: MarkdownElementProps<"div">) {
  const mathSource = mathSourceForNode(node);
  if (!mathSource) {
    return (
      <div className={className} {...props}>
        {children}
      </div>
    );
  }

  return (
    <div className={`${className ?? ""} ${styles["mathBlock"]}`} {...props}>
      {children}
      <span className={styles["mathCopy"]}>
        <CopyButton label="复制 TeX" value={mathSource} />
      </span>
    </div>
  );
}

interface CodeBlockProps {
  readonly code: string;
  readonly language: string;
}

function CodeBlock({ code, language }: CodeBlockProps) {
  const requestKey = `${language}\u0000${code}`;
  const [highlight, setHighlight] = useState<{
    readonly failed?: boolean;
    readonly html?: string;
    readonly key: string;
  }>({ key: requestKey });
  const highlightedHtml =
    highlight.key === requestKey ? highlight.html : undefined;
  const failed = highlight.key === requestKey && highlight.failed === true;

  useEffect(() => {
    let active = true;

    void import("shiki")
      .then(({ codeToHtml }) =>
        codeToHtml(code, {
          defaultColor: "light-dark()",
          lang: language || "text",
          themes: {
            dark: "github-dark",
            light: "github-light",
          },
        }),
      )
      .then((html) => {
        if (active) {
          setHighlight({ html, key: requestKey });
        }
      })
      .catch(() => {
        if (active) {
          setHighlight({ failed: true, key: requestKey });
        }
      });

    return () => {
      active = false;
    };
  }, [code, language, requestKey]);

  return (
    <section
      className={styles["codeBlock"]}
      aria-label={`${language || "text"} 代码块`}
    >
      <header>
        <span>
          <Code2 aria-hidden="true" size={15} />
          {language || "text"}
        </span>
        <CopyButton label="复制代码" value={code} />
      </header>
      {highlightedHtml ? (
        <div
          className={styles["highlightedCode"]}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre data-highlight-failed={failed || undefined}>
          <code>{code}</code>
        </pre>
      )}
    </section>
  );
}

interface MermaidBlockProps {
  readonly source: string;
}

function MermaidBlock({ source }: MermaidBlockProps) {
  const reactId = useId();
  const diagramId = useMemo(
    () => `charamate-mermaid-${reactId.replaceAll(/[^A-Za-z0-9_-]/gu, "")}`,
    [reactId],
  );
  const [view, setView] = useState<"diagram" | "source">("diagram");
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (view !== "diagram" || svg) {
      return;
    }
    let active = true;
    void import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          securityLevel: "strict",
          startOnLoad: false,
          theme: "neutral",
        });
        return mermaid.render(diagramId, source);
      })
      .then(({ svg: renderedSvg }) => {
        if (active) {
          setSvg(renderedSvg);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error ? reason.message : "Mermaid 渲染失败",
          );
        }
      });

    return () => {
      active = false;
    };
  }, [diagramId, source, svg, view]);

  return (
    <section className={styles["mermaidBlock"]} aria-label="Mermaid 图表">
      <header>
        <span>Mermaid</span>
        <div>
          <button
            type="button"
            aria-pressed={view === "diagram"}
            onClick={() => setView("diagram")}
          >
            图
          </button>
          <button
            type="button"
            aria-pressed={view === "source"}
            onClick={() => setView("source")}
          >
            源码
          </button>
          <CopyButton label="复制源码" value={source} />
        </div>
      </header>
      {view === "source" ? (
        <pre>
          <code>{source}</code>
        </pre>
      ) : error ? (
        <div className={styles["renderError"]} role="alert">
          <AlertCircle aria-hidden="true" size={16} />
          <span>{error}</span>
        </div>
      ) : svg ? (
        <div
          className={styles["mermaidDiagram"]}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className={styles["renderPending"]}>正在绘制图表…</div>
      )}
    </section>
  );
}

function reactNodeText(node: ReactNode): string {
  if (
    typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "bigint"
  ) {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(reactNodeText).join("");
  }
  if (isValidElement<{ readonly children?: ReactNode }>(node)) {
    return reactNodeText(node.props.children);
  }
  return "";
}

function MarkdownPre({ children }: MarkdownElementProps<"pre">) {
  const child = Children.only(children);
  if (!isValidElement(child)) {
    return <pre>{children}</pre>;
  }

  const codeElement = child as ReactElement<{
    readonly children?: ReactNode;
    readonly className?: string;
  }>;
  const code = reactNodeText(codeElement.props.children).replace(/\n$/u, "");
  const language =
    /language-([A-Za-z0-9_-]+)/u.exec(codeElement.props.className ?? "")?.[1] ??
    "text";

  return language === "mermaid" ? (
    <MermaidBlock source={code} />
  ) : (
    <CodeBlock code={code} language={language} />
  );
}

function MarkdownTable({
  children,
  node,
  ...props
}: MarkdownElementProps<"table">) {
  const source = useContext(MarkdownSourceContext);
  const tableSource = sourceForNode(source, node);
  return (
    <section className={styles["tableBlock"]}>
      <header>
        <span>
          <Table2 aria-hidden="true" size={15} />
          表格
        </span>
        {tableSource ? (
          <CopyButton label="复制 Markdown" value={tableSource} />
        ) : null}
      </header>
      <div>
        <table {...props}>{children}</table>
      </div>
    </section>
  );
}

function MarkdownImage({ alt, ...props }: MarkdownElementProps<"img">) {
  return (
    <figure className={styles["imageBlock"]}>
      <img {...props} alt={alt ?? ""} loading="lazy" />
      <figcaption>
        <ImageIcon aria-hidden="true" size={14} />
        {alt || "图片"}
      </figcaption>
    </figure>
  );
}

const markdownComponents: Components = {
  a: ({ children, ...props }) => (
    <a {...props} rel="noreferrer" target="_blank">
      {children}
    </a>
  ),
  code: ({ children, ...props }) => <code {...props}>{children}</code>,
  div: MathDiv,
  img: MarkdownImage,
  pre: MarkdownPre,
  span: MathSpan,
  table: MarkdownTable,
};

export interface MarkdownRendererProps {
  readonly source: string;
}

export function MarkdownRenderer({ source }: MarkdownRendererProps) {
  return (
    <MarkdownSourceContext.Provider value={source}>
      <div className={styles["markdown"]}>
        <ReactMarkdown
          components={markdownComponents}
          rehypePlugins={[
            rehypeMathSource,
            [rehypeSanitize, sanitizeSchema],
            [rehypeKatex, { strict: false, throwOnError: false }],
          ]}
          remarkPlugins={[
            remarkGfm,
            remarkCjkFriendly,
            remarkCjkFriendlyGfmStrikethrough,
            remarkMath,
          ]}
        >
          {source}
        </ReactMarkdown>
      </div>
    </MarkdownSourceContext.Provider>
  );
}
