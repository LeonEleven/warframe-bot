/**
 * 部署层守护测试：scripts/run-monitor.cmd 必须保持 ASCII-only + CRLF。
 *
 * 背景（真实踩过的坑）：
 * - 传统 Windows cmd.exe 按**本地代码页**解析批处理文件，脚本里出现 UTF-8 中文注释/echo 时，
 *   在简体中文 Windows 上会报出类似
 *     ''嬪簭璋冪敤锛?rem' 不是内部或外部命令'
 *     ''?rem' 不是内部或外部命令'
 *     ''cripts\' 不是内部或外部命令'
 *   的乱码解析错误，导致监控无法启动。
 * - %DATE% / %TIME% 会输出依赖系统 locale 的文本（例如「周一」），
 *   而 Node logger 写的是 UTF-8，两者混在同一个 logs\monitor.log 里就会变成混合编码。
 *
 * 因此这里锁死：纯 ASCII、CRLF、无 %DATE%/%TIME%、无绝对用户路径、无凭据。
 * 如果这个测试失败，请修 run-monitor.cmd（ASCII 英文注释 + CRLF），不要放宽测试。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT_URL = new URL('../scripts/run-monitor.cmd', import.meta.url);
const SCRIPT_PATH = fileURLToPath(SCRIPT_URL);

async function readScript(): Promise<{ text: string; bytes: Buffer }> {
  const bytes = await readFile(SCRIPT_URL);
  return { text: bytes.toString('utf8'), bytes };
}

test('run-monitor.cmd 存在且非空', async () => {
  const { text, bytes } = await readScript();

  assert.ok(bytes.length > 0, `${SCRIPT_PATH} 不应为空`);
  assert.ok(text.includes('@echo off'), '批处理应以 @echo off 开头');
});

test('run-monitor.cmd 全部字节 <= 0x7F（ASCII-only，与代码页无关）', async () => {
  const { bytes } = await readScript();
  const offenders: string[] = [];

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte !== undefined && byte > 0x7f) {
      offenders.push(`offset ${index}: 0x${byte.toString(16).padStart(2, '0')}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `${SCRIPT_PATH} 必须 ASCII-only（不得含中文注释/echo/非 ASCII 符号）；违规字节: ${offenders.join(', ')}`,
  );
});

test('run-monitor.cmd 全部字符 code point <= 127', async () => {
  const { text } = await readScript();
  const nonAscii = [...text].filter((char) => (char.codePointAt(0) ?? 0) > 127);

  assert.deepEqual(nonAscii, [], `不得出现非 ASCII 字符，实际出现: ${JSON.stringify(nonAscii.slice(0, 10))}`);
});

test('run-monitor.cmd 使用 CRLF 换行并以换行结尾', async () => {
  const { text } = await readScript();

  assert.ok(text.includes('\r\n'), '批处理必须使用 CRLF 换行');
  assert.equal(
    text.split('\n').length - 1,
    text.split('\r\n').length - 1,
    '不得出现单独的 LF（必须全部是 CRLF）',
  );
  assert.equal(
    text.split('\r').length - 1,
    text.split('\r\n').length - 1,
    '不得出现单独的 CR（必须全部是 CRLF）',
  );
  assert.ok(text.endsWith('\r\n'), '文件应以 CRLF 结尾');
});

test('run-monitor.cmd 运行编译产物并把 Node 输出追加到 logs\\monitor.log', async () => {
  const { text } = await readScript();

  assert.ok(text.includes('node "dist\\index.js"'), '必须运行编译产物 node "dist\\index.js"');
  assert.ok(text.includes('logs\\monitor.log'), '必须把输出写入 logs\\monitor.log');
  assert.match(text, /node "dist\\index\.js" >>"logs\\monitor\.log" 2>&1/, 'stdout/stderr 都应追加到日志');
  assert.ok(text.includes('if not exist "logs" mkdir "logs"'), '日志目录不存在时应创建');
  assert.ok(text.includes('%~dp0'), '必须通过 %~dp0 相对定位项目根目录');
  assert.ok(text.includes('cd /d "%~dp0.."'), '必须切到项目根目录');
});

test('run-monitor.cmd 不使用 %DATE% / %TIME%（避免本地化字符与混合编码）', async () => {
  const { text } = await readScript();

  assert.doesNotMatch(text, /%DATE%/i, '不得使用 %DATE%：可能输出「周一」等本地化字符');
  assert.doesNotMatch(text, /%TIME%/i, '不得使用 %TIME%：属于本地化时间格式');
  // 时间戳统一由 Node logger 输出
  assert.ok(text.includes('===== START ====='), 'START 行应为不含日期时间的 ASCII 文本');
  assert.match(text, /===== EXIT code=%EXIT_CODE% =====/, 'EXIT 行应只包含 ASCII 文本与退出码');
});

test('run-monitor.cmd 不包含用户机器绝对路径', async () => {
  const { text } = await readScript();

  assert.doesNotMatch(text, /C:\\Users\\/i, '不得写死 C:\\Users\\ 等用户目录');
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]/, '不得出现任何盘符绝对路径，必须使用 %~dp0 相对定位');
});

test('run-monitor.cmd 不包含任何凭据或敏感配置', async () => {
  const { text } = await readScript();

  for (const secret of ['TARGET_QQ', 'NAPCAT_TOKEN', 'NAPCAT_BASE_URL', 'WARFRAME_PROXY_URL', 'HTTP_PROXY', 'HTTPS_PROXY']) {
    assert.ok(!text.includes(secret), `批处理中不得出现 ${secret}`);
  }
  assert.doesNotMatch(text, /\btoken\s*=/i, '批处理中不得出现 token= 形式的赋值');
});

test('run-monitor.cmd 把 Node 退出码返回给调用方，且不改代码页', async () => {
  const { text } = await readScript();

  assert.ok(text.includes('set "EXIT_CODE=%ERRORLEVEL%"'), '应保存 Node 的退出码');
  assert.ok(text.includes('exit /b %EXIT_CODE%'), '应把 Node 退出码返回给调用方');
  assert.ok(text.includes('if not exist "dist\\index.js"'), '缺少编译产物时应给出明确提示');
  assert.ok(text.includes('exit /b 1'), '缺少编译产物时应以非零码退出');
  assert.doesNotMatch(text, /chcp/i, '不得通过 chcp 修改代码页');
});

test('run-monitor.cmd 不含乱码残留字符', async () => {
  const { text } = await readScript();

  // 历史故障中出现的典型乱码片段
  for (const garbled of ['嬪', '簭', '璋', '冪', '敤', '锛', '�']) {
    assert.ok(!text.includes(garbled), `不得包含乱码字符 ${garbled}`);
  }
});
