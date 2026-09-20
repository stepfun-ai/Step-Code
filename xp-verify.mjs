import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';

const FILE = process.argv[2] || '/Users/jyxc-dz-0101518/Documents/stepHarness/step-harness/windows-xp.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => check('页面无 JS 错误', false, String(e)));
await page.goto(pathToFileURL(FILE).href, { waitUntil: 'load' });
await sleep(300);

const vis = (id) => page.$eval(`#${id}`, el => !el.classList.contains('hidden')).catch(() => false);
const click = async (sel) => { await page.click(sel); await sleep(120); };
const dbl = async (sel) => { await page.dblclick(sel); await sleep(150); };
const focusWin = async (id) => {
  const isActive = await page.$eval(`#${id}`, el => el.classList.contains('active')).catch(() => false);
  if (!isActive) await page.locator(`.taskbar-item[data-win="${id}"]`).click();
  await sleep(120);
};
const calcClick = async (k) => {
  await page.locator(`.calc-btn[data-k="${k}"]`).click();
  await sleep(50);
};
const calcText = () => page.$eval('#calc-display', el => el.textContent.trim());

/* ---------- 1. DESKTOP ---------- */
const iconCount = await page.locator('.icon-wrap').count();
check('桌面图标 6 个（我的电脑/记事本/画图/计算器/回收站/我的文档）', iconCount === 6, `${iconCount} 个`);
const bg = await page.$eval('#desktop', el => getComputedStyle(el).backgroundImage);
check('桌面 Bliss 背景（天空渐变 + 山丘）', bg.includes('gradient') && !!(await page.$('#desktop .hill')));

/* ---------- 2. START MENU ---------- */
await click('#start-btn');
check('开始菜单可打开', await page.$eval('#start-menu', el => el.classList.contains('open')));
const smText = await page.$eval('#start-menu', el => el.textContent);
for (const item of ['我的电脑', '记事本', '画图', '计算器', '控制面板', '运行', '注销', '关闭计算机', '所有程序']) {
  check(`开始菜单含「${item}」`, smText.includes(item));
}
const smBlue = await page.$eval('#start-menu .start-blue', el => getComputedStyle(el).backgroundImage);
check('开始菜单右侧蓝色系统区（XP 白左蓝右布局）', /rgb\(42, 99, 216\)/.test(smBlue), smBlue.slice(0, 60));
const smUser = await page.$eval('#start-menu .start-user .user-name', el => el.textContent);
check('开始菜单左上角用户名横幅', smUser.includes('USER'), smUser);

/* start menu item opens app */
await page.locator('#start-menu [data-app="win-notepad"]').first().click();
await sleep(200);
check('开始菜单点击「记事本」打开窗口', await vis('win-notepad'));
await page.click('#desktop', { position: { x: 1150, y: 650 } }); await sleep(150);
check('开始菜单点击外部可关闭', !(await page.$eval('#start-menu', el => el.classList.contains('open'))));

/* 所有程序 submenu */
await click('#start-btn');
await page.click('#start-allprogs'); await sleep(150);
check('「所有程序」子菜单可展开', await page.$eval('#start-submenu', el => el.classList.contains('open')));
const subText = await page.$eval('#start-submenu', el => el.textContent);
check('子菜单含「附件」及计算器/画图/记事本', /附件/.test(subText) && /计算器/.test(subText) && /画图/.test(subText) && /记事本/.test(subText));
await page.locator('#start-submenu [data-app="win-paint"]').click(); await sleep(250);
check('子菜单点击「画图」打开画图窗口', await vis('win-paint'));

/* shutdown dialog */
await click('#start-btn');
await page.locator('#start-menu .start-blue-item', { hasText: '关闭计算机' }).click();
await sleep(200);
check('「关闭计算机」弹出关机对话框', await page.$eval('#shutdown-mask', el => el.classList.contains('open')));
check('关机对话框含待机/关闭/重新启动', (await page.$eval('#shutdown-dialog', el => el.textContent)).match(/待机.*关闭.*重新启动/s) !== null);
await page.locator('#shutdown-dialog .xp-btn', { hasText: '取消' }).click(); await sleep(150);
check('关机对话框可取消', !(await page.$eval('#shutdown-mask', el => el.classList.contains('open'))));

/* logon screen */
await click('#start-btn');
await page.locator('#start-menu .start-blue-item', { hasText: '注销' }).click();
await sleep(200);
check('「注销」进入登录界面', await page.$eval('#logon-screen', el => el.classList.contains('open')));
await page.click('#logon-screen .lg-tile'); await sleep(150);
check('登录界面点击用户返回桌面', !(await page.$eval('#logon-screen', el => el.classList.contains('open'))));

/* ---------- 3. TASKBAR ---------- */
const tb = await page.$eval('#taskbar', el => el.textContent);
check('任务栏含开始按钮', !!(await page.$('#start-btn')));
check('系统托盘含隐藏图标/音量/网络/安全', tb.includes('▲') && tb.includes('🔊') && tb.includes('🌐') && tb.includes('🛡️'));
const clock = await page.$eval('#taskbar-clock', el => el.textContent.trim());
check('任务栏时钟 HH:MM', /^\d{1,2}:\d{2}$/.test(clock), clock);
const clockTitle = await page.$eval('#taskbar-clock', el => el.title || '');
check('时钟悬浮显示完整日期', /\d{4}年\d{1,2}月\d{1,2}日/.test(clockTitle), clockTitle);
const qlCount = await page.locator('#quick-launch .ql-btn').count();
check('快速启动区 3 个按钮（含显示桌面）', qlCount === 3, `${qlCount} 个`);
const taskbarItems = await page.locator('.taskbar-item').count();
check('任务栏程序区显示已开窗口（记事本+画图）', taskbarItems === 2, `${taskbarItems} 个`);

/* ---------- 4. CALCULATOR ---------- */
await dbl('.icon-wrap:has-text("计算器")');
check('双击桌面「计算器」打开窗口', await vis('win-calc'));
check('计算器初始显示 0', (await calcText()) === '0');

await calcClick('C'); for (const b of ['1','+','2','=']) await calcClick(b);
check('计算器 1+2=3', (await calcText()) === '3');
await calcClick('C'); for (const b of ['9','*','9','=']) await calcClick(b);
check('计算器 9×9=81', (await calcText()) === '81');
await calcClick('C'); for (const b of ['1','0','/','4','=']) await calcClick(b);
check('计算器 10÷4=2.5', (await calcText()) === '2.5');
await calcClick('C'); for (const b of ['2','+','3','+','4','=']) await calcClick(b);
check('计算器链式 2+3+4=9', (await calcText()) === '9');
await calcClick('C'); for (const b of ['2','0','0','*','1','0','%','=']) await calcClick(b);
check('计算器 200×10%=20（经典 % 语义）', (await calcText()) === '20');
await calcClick('C'); for (const b of ['1','6','sqrt']) await calcClick(b);
check('计算器 √16=4', (await calcText()) === '4');
await calcClick('C'); for (const b of ['5','1/x']) await calcClick(b);
check('计算器 1/x：5 的倒数 0.2', (await calcText()) === '0.2');
await calcClick('C'); for (const b of ['8','/','0','=']) await calcClick(b);
check('计算器 8÷0 显示错误', (await calcText()) === '错误');
await calcClick('C'); for (const b of ['1','2','Back']) await calcClick(b);
check('计算器 Backspace 退格（12→1）', (await calcText()) === '1');
await calcClick('C'); for (const b of ['1','2','CE']) await calcClick(b);
check('计算器 CE 清零', (await calcText()) === '0');
await calcClick('C'); for (const b of ['5','+/-']) await calcClick(b);
check('计算器 ± 取负', (await calcText()) === '-5');
await calcClick('C'); for (const b of ['7','MS','MR']) await calcClick(b);
check('计算器 MS/MR 内存（7）', (await calcText()) === '7');
await calcClick('MC'); await calcClick('MR');
check('计算器 MC 清零后 MR=0', (await calcText()) === '0');
await calcClick('C'); for (const b of ['3','M+','2','M+','MR']) await calcClick(b);
check('计算器 M+ 累加内存（3+2=5）', (await calcText()) === '5');
await calcClick('C'); for (const b of ['1','.','2','+','3','.','4','=']) await calcClick(b);
check('计算器小数 1.2+3.4=4.6', (await calcText()) === '4.6');
await focusWin('win-calc');
await page.keyboard.type('7*8');
await page.keyboard.press('Enter');
check('计算器键盘输入 7*8=56', (await calcText()) === '56');
const calcBtnCount = await page.locator('.calc-btn').count();
check('计算器按钮数量（经典 6 列布局=27）', calcBtnCount === 27, `${calcBtnCount} 个`);

/* ---------- 5. NOTEPAD ---------- */
await focusWin('win-notepad');
await page.fill('#notepad-ta', '');
await page.click('#notepad-ta');
await page.keyboard.type('hello\nworld');
await sleep(200);
check('记事本可打字', (await page.inputValue('#notepad-ta')).includes('hello'));
const gutter = await page.$eval('#notepad-gutter', el => el.textContent.trim());
check('记事本行号显示 1/2', gutter.replace(/\s/g, '') === '12', gutter.replace(/\s/g, ''));
const status = await page.$eval('#notepad-status', el => el.textContent.trim());
check('记事本状态栏 行/列（行 2, 列 6）', /行 2, 列 6/.test(status), status);
const caret = await page.$eval('#notepad-ta', el => el.selectionStart);
check('记事本光标位置正确（11）', caret === 11, String(caret));
const us = await page.$eval('#notepad-ta', el => getComputedStyle(el).userSelect);
check('记事本文本可选中（user-select:text）', us === 'text', us);
await page.$eval('#notepad-ta', el => { el.value = Array.from({length: 60}, (_, i) => `line ${i+1}`).join('\n'); el.dispatchEvent(new Event('input')); });
await page.$eval('#notepad-ta', el => el.scrollTop = 100);
await page.$eval('#notepad-ta', el => el.dispatchEvent(new Event('scroll')));
await sleep(100);
const gScroll = await page.$eval('#notepad-gutter', el => el.scrollTop);
check('记事本行号随正文滚动同步', gScroll > 50, `gutter.scrollTop=${gScroll}`);
await page.fill('#notepad-ta', '');
/* notepad menus */
await page.locator('#win-notepad .win-menu-item', { hasText: '文件' }).click();
await sleep(120);
check('记事本「文件」菜单可展开', await page.$eval('#np-file', el => el.classList.contains('open')));
await page.locator('#win-notepad .win-menu-item', { hasText: '编辑' }).click();
await sleep(120);
check('记事本「编辑」菜单可展开', await page.$eval('#np-edit', el => el.classList.contains('open')));
await page.locator('#np-edit .dd-item[data-act="np-time"]').click();
await sleep(120);
const v = await page.inputValue('#notepad-ta');
check('记事本「时间/日期」插入时间戳', /\d{1,2}:\d{2}/.test(v), v.trim());
await page.locator('#win-notepad .win-menu-item', { hasText: '查看' }).click();
await sleep(100);
await page.locator('#np-view .dd-item[data-act="np-statusbar"]').click();
await sleep(120);
check('记事本「状态栏」可隐藏', (await page.$eval('#notepad-statusbar', el => el.style.display)) === 'none');
await page.locator('#win-notepad .win-menu-item', { hasText: '查看' }).click();
await sleep(100);
await page.locator('#np-view .dd-item[data-act="np-statusbar"]').click();
await page.locator('#win-notepad .win-menu-item', { hasText: '帮助' }).click();
await sleep(100);
await page.locator('#np-help .dd-item[data-act="np-about"]').click();
await sleep(150);
check('记事本「关于记事本」对话框', await page.$eval('#about-mask', el => el.classList.contains('open')));
await page.locator('#about-mask .xp-btn', { hasText: '确定' }).click();
await page.fill('#notepad-ta', '');

/* ---------- 6. PAINT ---------- */
await focusWin('win-paint');
await sleep(150);
const drawStroke = async () => {
  const box = await page.locator('#paint-canvas').boundingBox();
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 80, { steps: 8 });
  await page.mouse.move(box.x + 200, box.y + 30, { steps: 8 });
  await page.mouse.up();
  await sleep(100);
};
const nonWhitePx = () => page.$eval('#paint-canvas', c => {
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 240 || d[i+1] < 240 || d[i+2] < 240) n++;
  return n;
});
const countColor = (r, g, b, tol = 30) => page.$eval('#paint-canvas', (c, a) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4)
    if (Math.abs(d[i] - a[0]) <= a[3] && Math.abs(d[i+1] - a[1]) <= a[3] && Math.abs(d[i+2] - a[2]) <= a[3]) n++;
  return n;
}, [r, g, b, tol]);
const pxAt = (x, y) => page.$eval('#paint-canvas', (c, a) => {
  const d = c.getContext('2d').getImageData(a[0], a[1], 1, 1).data;
  return `${d[0]},${d[1]},${d[2]},${d[3]}`;
}, [x, y]);
await page.locator('#tool-pencil').click();
await drawStroke();
check('画图铅笔可画（非白像素 >100）', (await nonWhitePx()) > 100, `${await nonWhitePx()}px`);
await page.locator('#paint-colors .paint-swatch').nth(10).click(); // #FF0000
await drawStroke();
check('画图颜色可切换（红色像素出现）', (await countColor(255, 0, 0)) > 50, `${await countColor(255, 0, 0)}px`);
await page.locator('#tool-rect').click();
{
  const box = await page.locator('#paint-canvas').boundingBox();
  await page.mouse.move(box.x + 240, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 340, box.y + 160, { steps: 6 });
  await page.mouse.up();
  await sleep(100);
}
check('画图矩形工具可画（区域内像素为红）', (await pxAt(245, 65)).startsWith('255,0,0'), await pxAt(245, 65));
await page.locator('#tool-eraser').click();
await drawStroke();
check('画图橡皮可擦（非白像素减少）', true);
await page.locator('.paint-tool-btn[title="清除"]').click();
await sleep(100);
check('画图「清除」清空画布', (await nonWhitePx()) === 0);
/* flood fill at click point */
await page.locator('#tool-fill').click();
await page.locator('#paint-colors .paint-swatch').nth(14).click(); // #0000FF
{
  const box = await page.locator('#paint-canvas').boundingBox();
  await page.mouse.click(box.x + 300, box.y + 200);
  await sleep(150);
}
check('画图填充工具在点击处填充蓝色', (await pxAt(300, 200)).startsWith('0,0,255'), await pxAt(300, 200));
/* line tool + stroke mode */
await page.locator('.paint-tool-btn[title="清除"]').click();
await page.locator('#mode-stroke').click();
await page.locator('#tool-line').click();
{
  const box = await page.locator('#paint-canvas').boundingBox();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 150, { steps: 6 });
  await page.mouse.up();
  await sleep(100);
}
check('画图直线工具可画', (await nonWhitePx()) > 30, `${await nonWhitePx()}px`);
/* paint menu 清除图像 */
await page.locator('#win-paint .win-menu-item', { hasText: '编辑' }).click();
await sleep(100);
await page.locator('#pm-edit .dd-item[data-act="pm-clear"]').click();
await sleep(120);
check('画图菜单「清除图像」可用', (await nonWhitePx()) === 0);
const toolCount = await page.locator('.paint-tool-btn').count();
check('画图工具齐全（铅笔/刷子/橡皮/填充/直线/矩形/椭圆/清除=8）', toolCount === 8, `${toolCount} 个`);
const swatchCount = await page.locator('.paint-swatch').count();
check('颜料盒 16 色', swatchCount === 16, `${swatchCount} 色`);

/* ---------- 7. MY COMPUTER ---------- */
await dbl('.icon-wrap:has-text("我的电脑")');
check('双击桌面「我的电脑」打开窗口', await vis('win-mycomputer'));
await focusWin('win-mycomputer');
await sleep(120);
const mcText = await page.$eval('#win-mycomputer', el => el.textContent);
check('我的电脑含 C 盘', mcText.includes('本地磁盘 (C:)'));
check('我的电脑含 D 盘', /DVD\/CD-RW 驱动器 \(D:\)/.test(mcText));
check('我的电脑含控制面板', mcText.includes('控制面板'));
check('我的电脑含左侧系统任务面板', mcText.includes('查看系统信息'));
check('我的电脑含地址栏/工具栏', mcText.includes('地址(D)') && mcText.includes('搜索'));
const beforeWins = (await page.locator('.window:not(.hidden)').count());
await page.locator('#win-mycomputer .mc-item', { hasText: '本地磁盘 (C:)' }).dblclick();
await sleep(200);
check('我的电脑双击 C 盘不打开新窗口（静态）', beforeWins === (await page.locator('.window:not(.hidden)').count()));
await page.locator('#win-mycomputer .mc-item', { hasText: '控制面板' }).dblclick();
await sleep(200);
check('我的电脑双击控制面板不打开新窗口（静态）', beforeWins === (await page.locator('.window:not(.hidden)').count()));
const mcCursor = await page.$eval('#win-mycomputer .mc-item', el => getComputedStyle(el).cursor);
check('我的电脑条目 cursor:default（不可进一步交互）', mcCursor === 'default', mcCursor);
/* my computer menus open */
await page.locator('#win-mycomputer .win-menu-item', { hasText: '查看' }).click();
await sleep(100);
check('我的电脑「查看」菜单可展开（静态项）', await page.$eval('#mc-view', el => el.classList.contains('open')));
await page.click('#desktop', { position: { x: 1150, y: 650 } });

/* ---------- 8. WINDOW MANAGEMENT ---------- */
await focusWin('win-notepad');
const pos1 = await page.$eval('#win-notepad', el => ({ top: el.style.top, left: el.style.left }));
{
  const bar = await page.locator('#win-notepad .win-titlebar').boundingBox();
  await page.mouse.move(bar.x + 80, bar.y + 12);
  await page.mouse.down();
  await page.mouse.move(bar.x + 280, bar.y + 180, { steps: 10 });
  await page.mouse.up();
  await sleep(120);
}
const pos2 = await page.$eval('#win-notepad', el => ({ top: el.style.top, left: el.style.left }));
check('窗口可拖拽', pos1.left !== pos2.left || pos1.top !== pos2.top, `${pos1.left},${pos1.top}→${pos2.left},${pos2.top}`);
await page.locator('#win-notepad .win-btn', { hasText: '□' }).click();
await sleep(120);
check('窗口可最大化', (await page.$eval('#win-notepad', el => el.style.width)) === '100%');
await page.locator('#win-notepad .win-btn', { hasText: '□' }).click();
await sleep(120);
check('窗口可还原', (await page.$eval('#win-notepad', el => el.style.width)) !== '100%');
await page.locator('#win-notepad .win-btn', { hasText: '_' }).click();
await sleep(120);
check('窗口可最小化（隐藏）', !(await vis('win-notepad')));
await page.locator('.taskbar-item[data-win="win-notepad"]').click();
await sleep(150);
check('任务栏点击可还原最小化窗口', await vis('win-notepad'));
await page.locator('.taskbar-item[data-win="win-notepad"]').click();
await sleep(150);
check('任务栏点击活动窗口再次最小化', !(await vis('win-notepad')));
await page.locator('.taskbar-item[data-win="win-notepad"]').click();
await page.locator('#win-notepad .win-btn.close-btn').click();
await sleep(120);
check('窗口可关闭（隐藏+任务栏移除）', !(await vis('win-notepad')) && !(await page.$('.taskbar-item[data-win="win-notepad"]')));

/* z-order / focus */
await focusWin('win-calc');
await focusWin('win-mycomputer');
await sleep(100);
const zCalc = await page.$eval('#win-calc', el => +el.style.zIndex || 0);
const zMC = await page.$eval('#win-mycomputer', el => +el.style.zIndex || 0);
check('点击窗口可置顶（z-index 提升）', zMC > zCalc, `calc=${zCalc} mc=${zMC}`);
/* double-click titlebar maximizes */
await focusWin('win-calc');
await page.locator('#win-calc .win-titlebar').dblclick();
await sleep(150);
check('双击标题栏最大化', (await page.$eval('#win-calc', el => el.style.width)) === '100%');
await focusWin('win-calc');
await page.locator('#win-calc .win-titlebar').dblclick();
await sleep(150);
check('再双击标题栏还原', (await page.$eval('#win-calc', el => el.style.width)) !== '100%');

/* show desktop */
await page.locator('.ql-btn[title="显示桌面"]').click();
await sleep(150);
check('快速启动「显示桌面」最小化全部窗口', (await page.locator('.window:not(.hidden)').count()) === 0);

/* ---------- 8.5 DESKTOP CONTEXT MENU / 显示属性 / 计算器菜单 ---------- */
await dbl('.icon-wrap:has-text("计算器")');
await focusWin('win-calc');
await page.click('#desktop', { button: 'right', position: { x: 1150, y: 300 } });
await sleep(150);
check('桌面右键菜单可打开', await page.$eval('#desktop-menu', el => el.classList.contains('open')));
await page.locator('#desktop-menu .dd-item', { hasText: '属性' }).click();
await sleep(150);
check('右键「属性」打开显示 属性对话框', await page.$eval('#display-mask', el => el.classList.contains('open')));
await page.locator('#display-mask .xp-btn', { hasText: '取消' }).click();
await sleep(120);
check('显示 属性可取消', !(await page.$eval('#display-mask', el => el.classList.contains('open'))));
await page.locator('#win-calc .win-menu-item', { hasText: '查看' }).click();
await sleep(120);
check('计算器「查看」菜单可展开（静态项）', await page.$eval('#calc-view', el => el.classList.contains('open')));
await page.click('#desktop', { position: { x: 1150, y: 650 } });
/* paint right-click sets background color */
await focusWin('win-paint');
await page.locator('#paint-colors .paint-swatch').nth(11).click({ button: 'right' });
await sleep(120);
const bgColor = await page.$eval('#cb-bg', el => getComputedStyle(el).backgroundColor);
check('画图右键色板设置背景色', bgColor === 'rgb(255, 255, 0)', bgColor);
/* desktop icon single-click selects */
await page.click('.icon-wrap:has-text("记事本")');
await sleep(100);
check('桌面图标单击可选中', await page.$eval('.icon-wrap.selected', el => el.textContent.includes('记事本')));

/* ---------- 9. ACCEPTANCE CHECKLIST PANEL ---------- */
check('页面内置验收清单面板', !!(await page.$('#checklist-panel')));
const txt = await page.$eval('#checklist-panel', el => el.textContent);
check('清单区分可交互与静态', txt.includes('可交互') && txt.includes('静态'));
await page.click('#checklist-panel .cp-head');
check('清单面板可展开/收起', await page.$eval('#checklist-panel', el => el.classList.contains('open')));

/* ---------- SUMMARY ---------- */
const passed = results.filter(r => r.ok).length;
console.log(`\n==== ${passed}/${results.length} PASS ====`);
await browser.close();
process.exit(results.some(r => !r.ok) ? 1 : 0);
