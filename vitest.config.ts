import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: false,
    // 既定 5 秒だと bodyTruncation の重いケース(64KB 本文 × PII redaction、
    // 手元 13〜19 秒 / CI 25 秒)が必ずタイムアウトする。手元で偶然通っていたのは
    // 実行環境差で、CI の遅いランナーで顕在化した(2026-07-24)。処理内容は正当
    // (上限判定を実データ量で検証する統合テスト)なので、閾値側を実測に合わせる。
    testTimeout: 60_000,
  },
});
