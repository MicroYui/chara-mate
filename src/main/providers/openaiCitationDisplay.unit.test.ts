import type {
  ResponseOutputMessage,
  ResponseOutputText,
} from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";

import fixture from "../../../tests/fixtures/openai-citations.json";
import { openAIResponseDisplayText } from "./openaiCitationDisplay";

const marker = "\uE200cite\uE202turn0search0\uE201";
function citation(
  start: number,
  end: number,
  url = "https://example.com/a",
): ResponseOutputText.URLCitation {
  return {
    type: "url_citation",
    start_index: start,
    end_index: end,
    title: "来源",
    url,
  };
}
function message(
  text: string,
  annotations: ResponseOutputText["annotations"] = [],
): ResponseOutputMessage {
  return {
    id: "message-1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations }],
  };
}

describe("OpenAI final citation display", () => {
  it("keeps the exact already-clickable citation from the observed Provider output", () => {
    const url = "https://www.foodallergy.org/resources/dining-out";
    const linked = `([foodallergy.org](${url}))`;
    const text = `核对来源。${linked}\n下一段。`;
    const start = text.indexOf(linked);
    const item = message(text, [citation(start, start + linked.length, url)]);
    const before = structuredClone(item);
    expect(openAIResponseDisplayText([item])).toBe(text);
    expect(item).toEqual(before);
  });

  it("still cites a separate prose passage using the same URL", () => {
    const linked = "([来源](https://example.com/a))";
    const text = `${linked}\n另一处事实。`;
    expect(
      openAIResponseDisplayText([
        message(text, [
          citation(0, linked.length),
          citation(linked.length + 1, text.length),
        ]),
      ]),
    ).toBe(`${text}[1](<https://example.com/a> "来源")`);
  });

  it("keeps repeated linked citations and materializes an actual native marker", () => {
    const linked = "([来源](https://example.com/a))";
    const text = `${linked}\n${linked}\n${marker}`;
    expect(
      openAIResponseDisplayText([
        message(text, [
          citation(0, linked.length),
          citation(linked.length + 1, linked.length * 2 + 1),
          citation(linked.length * 2 + 2, text.length),
        ]),
      ]),
    ).toBe(`${linked}\n${linked}\n[1](<https://example.com/a> "来源")`);
  });

  it.each([
    "`%s`",
    "```markdown\n%s\n```",
    "~~~markdown\n%s\n~~~",
    "    %s",
    "![image\n%s\n](https://example.com/image.png)",
    "$%s$",
    "\\%s",
    "<pre>%s</pre>",
    "| Left | Right |\n| --- | --- |\n| prefix | %s |",
  ])(
    "retains the source in a potentially non-clickable context: %s",
    (format) => {
      const linked = "([来源](https://example.com/a))";
      const text = format.replace("%s", linked);
      const start = text.indexOf(linked);
      expect(
        openAIResponseDisplayText([
          message(text, [citation(start, start + linked.length)]),
        ]),
      ).toBe(
        `${text.slice(0, start + linked.length)}[1](<https://example.com/a> "来源")${text.slice(start + linked.length)}`,
      );
    },
  );

  it.each([
    {
      text: "([   ](https://example.com/a))",
      url: "https://example.com/a",
    },
    {
      text: "([&nbsp;](https://example.com/a))",
      url: "https://example.com/a",
    },
    {
      text: "([来源](https://example.com/other))",
      url: "https://example.com/a",
    },
    {
      text: '([来源](https://example.com/a "title"))',
      url: "https://example.com/a",
    },
    {
      text: "([来源](https://example.com/a?x=1&amp;y=2))",
      url: "https://example.com/a?x=1&amp;y=2",
    },
    {
      text: "([复[杂]标签](https://example.com/a))",
      url: "https://example.com/a",
    },
  ])(
    "preserves actual sources for unmatched or complex links: $text",
    ({ text, url }) => {
      expect(
        openAIResponseDisplayText([
          message(text, [citation(0, text.length, url)]),
        ]),
      ).toBe(`${text}[1](<${url}> "来源")`);
    },
  );

  it("does not suppress a source for an invalid range, partial link or ambiguous Unicode offsets", () => {
    const linked = "([来源](https://example.com/a))";
    expect(
      openAIResponseDisplayText([
        message(linked, [citation(-1, linked.length)]),
      ]),
    ).toBe(`${linked} [1](<https://example.com/a> "来源")`);
    expect(openAIResponseDisplayText([message(linked, [citation(2, 4)])])).toBe(
      '([来源[1](<https://example.com/a> "来源")](https://example.com/a))',
    );
    expect(
      openAIResponseDisplayText([
        message(`🙂${linked}结束`, [citation(1, linked.length + 1)]),
      ]),
    ).toBe(`🙂${linked}结束 [1](<https://example.com/a> "来源")`);
  });

  it("materializes the saved citations without altering raw output", () => {
    const item = fixture.item as ResponseOutputMessage;
    const before = structuredClone(item);
    const display = openAIResponseDisplayText([item])!;
    expect(display).toContain(
      "[1](<https://docs.stripe.com/webhooks?lang=node&locale=en-GB&utm_source=openai>",
    );
    expect(display).toContain(
      "[2](<https://www.postgresql.org/docs/18/ddl-constraints.html?utm_source=openai>",
    );
    expect(display.replace(/\[[12]\]\(<[^>]+> "[^"]*"\)/gu, "")).toBe(
      fixture.deltas.join("").replace(/\uE200cite\uE202[^\uE201]+\uE201/gu, ""),
    );
    expect(item).toEqual(before);
  });

  it("keeps output order and reuses numbers across repeated URLs and parts", () => {
    const item = message(marker, [
      citation(0, marker.length),
      citation(0, marker.length, "https://example.com/b"),
      citation(0, marker.length),
    ]);
    item.content.push({
      type: "output_text",
      text: `后文${marker}`,
      annotations: [citation(2, 2 + marker.length)],
    });
    const display = openAIResponseDisplayText([item, message("结束")])!;
    expect(display).toBe(
      '[1](<https://example.com/a> "来源") [2](<https://example.com/b> "来源")后文[1](<https://example.com/a> "来源")结束',
    );
  });

  it.each(["普通回答。", '{"answer":"结构化正文"}', marker])(
    "leaves unannotated text unchanged: %s",
    (text) => {
      expect(openAIResponseDisplayText([message(text)])).toBeUndefined();
      expect(openAIResponseDisplayText(undefined)).toBeUndefined();
    },
  );

  it("preserves ordinary annotated prose and escapes link titles/destinations", () => {
    const value = citation(0, 3, "https://example.com/a b?q=<x>");
    value.title = '引文 "标题"\\说明\n下一行';
    expect(openAIResponseDisplayText([message("事实。后文", [value])])).toBe(
      '事实。[1](<https://example.com/a%20b?q=%3Cx%3E> "引文 \\"标题\\"\\\\说明 下一行")后文',
    );
  });

  it.each(["utf16", "codepoint"] as const)(
    "identifies an exact marker after emoji using %s offsets",
    (coordinates) => {
      const prefix = "你好🙂";
      const start =
        coordinates === "utf16" ? prefix.length : [...prefix].length;
      expect(
        openAIResponseDisplayText([
          message(prefix + marker, [citation(start, start + marker.length)]),
        ]),
      ).toBe('你好🙂[1](<https://example.com/a> "来源")');
    },
  );

  it("preserves text and appends only actual sources when positions are invalid or ambiguous", () => {
    const text = `🙂事实。${marker}`;
    const display = openAIResponseDisplayText([
      message(text, [citation(-1, 2), citation(1, 3, "https://example.com/b")]),
    ]);
    expect(display).toBe(
      `${text} [1](<https://example.com/a> "来源") [2](<https://example.com/b> "来源")`,
    );
    expect(
      openAIResponseDisplayText([
        message(marker, [citation(0, marker.length, "not-a-url")]),
      ]),
    ).toBeUndefined();
  });
});
