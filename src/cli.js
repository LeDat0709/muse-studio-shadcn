"use strict";

const path = require("path");
const { MuseServer } = require("./server");

async function main() {
  const port = Number(process.env.PORT || 18638);
  const srv = new MuseServer({
    rootDir: path.resolve(__dirname, ".."),
    port,
  });
  const url = await srv.start();
  console.log("=========================================================");
  console.log("  ⚡ Muse AI Studio (Node.js + shadcn/ui) đã khởi động!");
  console.log(`  🌐 Web UI Dashboard : ${url}`);
  console.log(`  🔌 OpenAI Base URL  : ${url}/v1`);
  console.log(`  🔑 API Key          : ${srv.store.settings.apiKey}`);
  console.log("=========================================================");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Lỗi khởi chạy server:", err);
    process.exit(1);
  });
}
