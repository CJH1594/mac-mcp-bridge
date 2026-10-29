import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { ApprovedSession } from "./oauth-store.js";
import type { LocalControl } from "./application-control.js";
import { errorMessage } from "./errors.js";

// Client metadata is untrusted. Escape terminal controls, newlines and bidi controls.
function display(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function remaining(expiresAt: number): string {
  const minutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000));
  return `${Math.floor(minutes / 60)}시간 ${String(minutes % 60).padStart(2, "0")}분`;
}

/** A stream adapter for local control; no HTTP route exposes these commands. */
export function startOperatorConsole(
  control: LocalControl,
  options: { input: Readable; output: Writable; cwd: string; endpoint?: string },
): { close(): void } {
  const terminal = options.output as Writable & { isTTY?: boolean; columns?: number };
  const interactive = !!terminal.isTTY && !!(options.input as Readable & { isTTY?: boolean }).isTTY;
  const lines = createInterface({ input: options.input, output: interactive ? options.output : undefined, terminal: interactive, crlfDelay: Infinity });
  let closed = false;
  let session: ApprovedSession | undefined;
  let showHelp = false;
  let notice = "";
  let commands = Promise.resolve();
  const render = () => {
    if (closed) return;
    const rule = `  ${"─".repeat(Math.max(20, Math.min(terminal.columns ?? 80, 100) - 4))}`;
    const active = session && session.expiresAt > Date.now() ? session : undefined;
    const body = [
      rule,
      `  폴더   ${display(options.cwd)}`,
      ...(options.endpoint ? [`  주소   ${display(options.endpoint)}`] : []),
      rule,
      ...(active ? [
        "  연결된 기기",
        "  요청번호    남은 시간",
        `  ${active.number}  ${remaining(active.expiresAt)}`,
        rule,
      ] : []),
      ...(active ? [] : ["  연결 하시려면 요청번호를 입력하세요."]),
      ...(notice ? [`  ${notice}`] : []),
      ...(showHelp ? [
        "  요청번호를 입력하면 즉시 승인됩니다. 거절하려면 deny 요청번호",
        "  stop         연결과 실행 작업을 정리한 뒤 새 연결 대기",
        "  reset time   현재 시점부터 승인 유효시간을 6시간으로 초기화",
        "  연결은 1개만 승인됩니다. 표시 시간은 접속 여부가 아닌 승인 유효시간입니다.",
        "  Enter        도움말 닫기",
      ] : []),
      active
        ? "  stop 연결 해제 · reset time 6시간 초기화 · Ctrl+C 앱 종료"
        : "  help 도움말 · Ctrl+C 앱 종료",
      "",
    ];
    if (interactive) options.output.write("\x1b[2J\x1b[H");
    options.output.write(body.join("\n") + "\n");
    if (interactive) { lines.setPrompt("  > "); lines.prompt(true); }
  };
  const refresh = async () => { session = await control.getApprovedSession(); render(); };
  const write = async (message: string) => { notice = message; await refresh(); };
  const failed = (error: unknown) => { notice = `오류: ${display(errorMessage(error))}`; render(); };
  const resize = () => render();
  if (interactive) {
    options.output.on("resize", resize);
    lines.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
  }
  void refresh().catch(failed);
  const timer = interactive ? setInterval(() => { void refresh().catch(failed); }, 30_000) : undefined;
  timer?.unref();
  const handle = async (line: string) => {
    if (closed) return;
    const [command, number, ...extra] = line.trim().toUpperCase().split(/\s+/);
    if (!command || ((command === "HELP" || command === "CLEAR") && !number)) {
      showHelp = command === "HELP"; notice = ""; await refresh(); return;
    }
    showHelp = false;
    if (command === "RESET" && number === "TIME" && extra.length === 0) {
      const reset = await control.resetSessionTime();
      await write(reset ? "남은 시간을 6시간으로 초기화했습니다." : "초기화할 승인된 연결이 없습니다. 새 연결을 승인하세요.");
      return;
    }
    if (command === "STOP" && !number) {
      notice = "접근을 차단하고 실행 작업을 정리하고 있습니다...";
      render();
      try {
        await control.disconnect();
        await write("연결을 해제했습니다. 토큰을 폐기하고 실행 작업을 종료했습니다.");
      } catch (error) {
        await write(`접근은 차단했지만 정리에 실패했습니다. 오류를 해결한 뒤 stop을 다시 입력하세요: ${display(errorMessage(error))}`);
      }
      return;
    }
    if (extra.length > 0) { await write("요청번호 또는 approve/deny 요청번호를 입력하세요."); return; }
    if (command === "DENY") {
      if (!number) { await write("요청번호를 먼저 입력하여 연결 정보를 확인하세요."); return; }
      control.inspectApproval(number);
      const decided = await control.decideApproval(number, false);
      await write(decided ? "연결을 거절했습니다." : "승인 대기 중인 요청번호가 없습니다. 브라우저의 번호를 확인하세요.");
      return;
    }
    if (number) { await write("요청번호 또는 approve/deny 요청번호를 입력하세요."); return; }
    const selected = control.inspectApproval(command || "");
    if (!selected) { await write("승인 대기 중인 요청번호가 없습니다. 브라우저의 번호를 확인하세요."); return; }
    const decided = await control.decideApproval(command!, true);
    session = await control.getApprovedSession();
    await write(decided ? "" : session
      ? "이미 승인된 연결이 있습니다. 연결은 한 개만 허용됩니다."
      : "요청이 만료되었거나 처리되었습니다. 연결을 다시 시작하세요.");
  };
  lines.on("line", (line) => { commands = commands.then(() => handle(line)).catch(failed); });
  return { close: () => {
    closed = true;
    if (timer) clearInterval(timer);
    options.output.removeListener("resize", resize);
    lines.close();
  } };
}
