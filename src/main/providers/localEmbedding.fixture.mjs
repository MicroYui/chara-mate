// Offline protocol fixture; it does not compute or claim semantic embeddings.
import process from "node:process";
import { Buffer } from "node:buffer";
import http from "node:http";
import { writeFileSync } from "node:fs";
const [socket, dimensions, marker, mode] = process.argv.slice(2);
http
  .createServer(async (request, response) => {
    const buffers = [];
    for await (const chunk of request) buffers.push(chunk);
    const input = buffers.length
      ? JSON.parse(Buffer.concat(buffers).toString())
      : undefined;
    const json = (body, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/health") {
      if (mode === "starting") {
        writeFileSync(marker, "starting");
        json({ status: "loading" }, 503);
        return;
      }
      if (mode === "bad-health") {
        json({ status: "invalid" });
        return;
      }
      json({ status: "ok" });
      return;
    }
    if (request.url === "/tokenize") {
      if (!input.add_special || input.parse_special !== false) {
        json({}, 400);
        return;
      }
      json({
        tokens: [1, ...Array.from(input.content).map((c) => c.codePointAt(0))],
      });
      return;
    }
    const tokens = input?.input?.[0];
    if (
      !Array.isArray(tokens) ||
      !tokens.every(Number.isInteger) ||
      input.encoding_format !== "float"
    ) {
      json({}, 400);
      return;
    }
    const text = String.fromCodePoint(...tokens.slice(1));
    if (text.includes("hold")) {
      writeFileSync(marker, "holding");
      return;
    }
    if (text.includes("partial")) {
      response.writeHead(200, { "content-length": 200 });
      response.write('{"data":');
      response.destroy();
      return;
    }
    const vector = Array(Number(dimensions)).fill(0);
    vector[0] = 3;
    vector[1] = 4;
    if (text.includes("overflow")) vector[0] = 1e100;
    if (text.includes("zero")) vector.fill(0);
    if (text.includes("wrong-size")) vector.pop();
    json({
      data: [{ index: 0, embedding: vector }],
      usage: { prompt_tokens: tokens.length },
    });
  })
  .listen(socket);
