// ============================================================
// スワップ複利シミュレーター ロジック本体
// ============================================================

const LOT_SIZE = 10000;     // 1Lotあたりの通貨数
const MARGIN_RATE = 0.04;   // 必要証拠金率(レバレッジ25倍)

function calcAdditionalLots(fund, rate, target) {
  return fund / (LOT_SIZE * rate * MARGIN_RATE * target);
}

function calcDeadlineRate(totalLots, avgEntryRate, totalCashDeposited) {
  if (totalLots <= 0) return NaN;
  const numerator = LOT_SIZE * totalLots * avgEntryRate - totalCashDeposited;
  const denominator = LOT_SIZE * totalLots * (1 - MARGIN_RATE);
  return numerator / denominator;
}

function makeRateFunc(scenario, currentRate, changePct, totalDays) {
  let endRate;
  if (scenario === 'flat') {
    endRate = currentRate;
  } else if (scenario === 'decline') {
    endRate = currentRate * (1 - changePct / 100);
  } else {
    endRate = currentRate * (1 + changePct / 100);
  }
  const rateFunc = (day) => {
    if (totalDays <= 0) return currentRate;
    const r = currentRate + (endRate - currentRate) * (day / totalDays);
    return Math.max(r, 0.01);
  };
  return { rateFunc, endRate };
}

function runSimulation({ initialLots, initialRate, initialEquity, target, monthlyContribution, swapPerLot, rateFunc, days, fundTrigger }) {
  let totalLots = initialLots;
  let totalCostBasis = initialLots * initialRate;
  let totalCashDeposited = initialEquity;
  let accumulatedFund = 0;

  const startRequiredMargin = LOT_SIZE * initialLots * initialRate * MARGIN_RATE;
  const startRatio = startRequiredMargin > 0 ? (initialEquity / startRequiredMargin * 100) : NaN;

  const records = [];
  for (let day = 0; day < days; day++) {
    const rate = rateFunc(day);
    const dailySwap = totalLots * swapPerLot;
    accumulatedFund += dailySwap;

    if (monthlyContribution > 0 && day > 0 && day % 30 === 0) {
      accumulatedFund += monthlyContribution;
    }

    while (accumulatedFund >= fundTrigger) {
      const qk = calcAdditionalLots(fundTrigger, rate, target);
      totalLots += qk;
      totalCostBasis += qk * rate;
      totalCashDeposited += fundTrigger;
      accumulatedFund -= fundTrigger;
    }

    const avgEntryRate = totalCostBasis / totalLots;
    const equity = totalCashDeposited + LOT_SIZE * totalLots * (rate - avgEntryRate);
    const requiredMargin = LOT_SIZE * totalLots * rate * MARGIN_RATE;
    const maintenanceRatio = requiredMargin > 0 ? (equity / requiredMargin * 100) : NaN;
    const deadlineRate = calcDeadlineRate(totalLots, avgEntryRate, totalCashDeposited);
    const bufferPct = rate > 0 ? (rate - deadlineRate) / rate * 100 : NaN;

    records.push({ day, month: day / 30, rate, totalLots, dailySwap, equity, maintenanceRatio, deadlineRate, bufferPct });
  }

  return { records, startRatio };
}

// ============================================================
// UI制御
// ============================================================

const els = {
  lots: document.getElementById('in-lots'),
  rate: document.getElementById('in-rate'),
  equity: document.getElementById('in-equity'),
  monthly: document.getElementById('in-monthly'),
  target: document.getElementById('in-target'),
  trigger: document.getElementById('in-trigger'),
  swap: document.getElementById('in-swap'),
  change: document.getElementById('in-change'),
  months: document.getElementById('in-months'),
};

let scenario = 'decline';

const scenarioLabels = {
  decline: '期間終了時点までの下落率',
  rise: '期間終了時点までの上昇率',
  flat: '',
};

document.getElementById('scenario-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  scenario = btn.dataset.v;
  document.querySelectorAll('#scenario-seg button').forEach(b => b.classList.toggle('active', b === btn));
  const changeField = document.getElementById('change-field');
  if (scenario === 'flat') {
    changeField.style.display = 'none';
  } else {
    changeField.style.display = '';
    document.getElementById('change-label').firstChild.textContent = scenarioLabels[scenario] + ' ';
  }
  update();
});

function fmtYen(v) { return '¥' + Math.round(v).toLocaleString(); }
function fmtNum(v, d = 1) { return Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }

let charts = {};

function buildChart(id, datasets, yLabel, secondaryLabel) {
  const scales = {
    x: {
      type: 'linear',
      title: { display: true, text: '経過月数', color: '#5f6c85', font: { size: 10 } },
      ticks: { color: '#5f6c85', font: { size: 10 }, maxTicksLimit: 8 },
      grid: { color: '#1f2a40' },
    },
    y: {
      type: 'linear',
      position: 'left',
      title: { display: true, text: yLabel, color: '#5f6c85', font: { size: 10 } },
      ticks: { color: '#5f6c85', font: { size: 10 } },
      grid: { color: '#1f2a40' },
    },
  };
  if (secondaryLabel) {
    scales.y1 = {
      type: 'linear',
      position: 'right',
      title: { display: true, text: secondaryLabel, color: '#5f6c85', font: { size: 10 } },
      ticks: { color: '#5f6c85', font: { size: 10 } },
      grid: { drawOnChartArea: false },
    };
  }

  // 既にグラフが存在する場合は、破棄せずデータと軸設定だけ差し替える(重い再構築を避けて高速化)
  if (charts[id]) {
    const chart = charts[id];
    chart.data.datasets = datasets;
    chart.options.scales = scales;
    chart.update('none'); // アニメーションなしで即時反映
    return;
  }

  const ctx = document.getElementById(id).getContext('2d');
  charts[id] = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#141d2e', borderColor: '#2a3650', borderWidth: 1, titleColor: '#eef1f7', bodyColor: '#eef1f7' },
      },
      scales,
    },
  });
}

// 入力欄横のプレビュー表示だけを更新する軽量処理(シミュレーションは実行しない)
function updatePreview() {
  const initialLots = parseFloat(els.lots.value) || 0;
  const initialRate = parseFloat(els.rate.value) || 0.01;
  const initialEquity = parseFloat(els.equity.value) || 0;
  const monthlyContribution = parseFloat(els.monthly.value) || 0;
  const targetPct = parseFloat(els.target.value);
  const fundTrigger = parseFloat(els.trigger.value) || 5000;
  const swapPerLot = parseFloat(els.swap.value) || 0;
  const changePct = parseFloat(els.change.value) || 0;
  const months = parseInt(els.months.value);

  document.getElementById('out-lots').textContent = fmtNum(initialLots, 1);
  document.getElementById('out-rate').textContent = fmtNum(initialRate, 3);
  document.getElementById('out-equity').textContent = Math.round(initialEquity).toLocaleString();
  document.getElementById('out-monthly').textContent = Math.round(monthlyContribution).toLocaleString();
  document.getElementById('out-target').textContent = targetPct + '%';
  document.getElementById('out-trigger').textContent = Math.round(fundTrigger).toLocaleString();
  document.getElementById('out-swap').textContent = fmtNum(swapPerLot, 1);
  document.getElementById('out-change').textContent = changePct + '%';
  document.getElementById('out-months').textContent = months + 'ヶ月';
}

function update() {
  updatePreview();

  const initialLots = parseFloat(els.lots.value) || 0;
  const initialRate = parseFloat(els.rate.value) || 0.01;
  const initialEquity = parseFloat(els.equity.value) || 0;
  const monthlyContribution = parseFloat(els.monthly.value) || 0;
  const targetPct = parseFloat(els.target.value);
  const target = targetPct / 100;
  const fundTrigger = parseFloat(els.trigger.value) || 5000;
  const swapPerLot = parseFloat(els.swap.value) || 0;
  const changePct = parseFloat(els.change.value) || 0;
  const months = parseInt(els.months.value);
  const days = months * 30;

  const { rateFunc, endRate } = makeRateFunc(scenario, initialRate, changePct, days);
  const { records, startRatio } = runSimulation({
    initialLots, initialRate, initialEquity, target, monthlyContribution, swapPerLot, rateFunc, days, fundTrigger,
  });

  const last = records[records.length - 1];
  const initialEquityVal = records[0].equity;
  const profit = last.equity - initialEquityVal;

  document.getElementById('stat-start-ratio').textContent = isFinite(startRatio) ? Math.round(startRatio) + '%' : '-';
  document.getElementById('stat-lots').textContent = fmtNum(last.totalLots, 1) + ' Lot';
  document.getElementById('stat-equity').textContent = fmtYen(last.equity);
  const profitEl = document.getElementById('stat-profit');
  profitEl.textContent = (profit >= 0 ? '+' : '') + fmtYen(profit);
  profitEl.className = 'delta ' + (profit >= 0 ? 'pos' : 'neg');
  document.getElementById('stat-buffer').textContent = isFinite(last.bufferPct) ? fmtNum(last.bufferPct, 1) + '%' : '-';

  // スナップショット表
  const snapMonths = [1, 3, 6, 12, 24, 36, 48, 60].filter(m => m <= months);
  const tbody = document.querySelector('#snap-table tbody');
  tbody.innerHTML = '';
  snapMonths.forEach(m => {
    const idx = Math.min(m * 30, records.length - 1);
    const r = records[idx];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${m}ヶ月</td><td>${fmtNum(r.totalLots,1)}</td><td>${Math.round(r.dailySwap).toLocaleString()}</td><td>${Math.round(r.equity).toLocaleString()}</td><td>${fmtNum(r.maintenanceRatio,1)}%</td>`;
    tbody.appendChild(tr);
  });

  // サンプリング(描画負荷軽減のため5日おき)
  const sampled = records.filter((_, i) => i % 5 === 0 || i === records.length - 1);

  buildChart('chart-lots', [
    { label: 'ロット数', data: sampled.map(r => ({ x: r.month, y: r.totalLots })), borderColor: '#3d8bf0', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, yAxisID: 'y' },
    { label: '日次スワップ', data: sampled.map(r => ({ x: r.month, y: r.dailySwap })), borderColor: '#f4794a', backgroundColor: 'transparent', borderWidth: 2, borderDash: [4, 3], pointRadius: 0, yAxisID: 'y1' },
  ], 'Lot', '円/日');

  buildChart('chart-equity', [
    { label: '純資産', data: sampled.map(r => ({ x: r.month, y: r.equity })), borderColor: '#34c98f', backgroundColor: 'rgba(52,201,143,0.12)', fill: true, borderWidth: 2, pointRadius: 0 },
  ], '円');

  buildChart('chart-deadline', [
    { label: '現在レート', data: sampled.map(r => ({ x: r.month, y: r.rate })), borderColor: '#3d8bf0', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0 },
    { label: 'デッドライン', data: sampled.map(r => ({ x: r.month, y: r.deadlineRate })), borderColor: '#f0524f', backgroundColor: 'transparent', borderWidth: 2, borderDash: [4, 3], pointRadius: 0 },
  ], '円');

  buildChart('chart-ratio', [
    { label: '維持率', data: sampled.map(r => ({ x: r.month, y: r.maintenanceRatio })), borderColor: '#a78ef0', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0 },
  ], '%');
}

function rafThrottle(fn) {
  let scheduled = false;
  return (...args) => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...args);
    });
  };
}

const throttledUpdate = rafThrottle(update);

// 数値入力欄: 入力中は軽量プレビューのみ更新し、フォーカスを外す/Enterで確定した時だけ
// 重いシミュレーション+グラフ再計算を実行する(編集中の固まりを避けるため)。
// スライダー: ドラッグ中はフレーム単位で間引きながら即時反映する。
Object.values(els).forEach(el => {
  if (el.type === 'range') {
    el.addEventListener('input', throttledUpdate);
  } else {
    el.addEventListener('input', updatePreview);
    el.addEventListener('change', update);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.blur(); // Enterで確定 → blurがchangeを発火させる
    });
  }
});

document.getElementById('apply-btn').addEventListener('click', update);

// 初期描画
update();

// ============================================================
// PWAインストール促進バナー & Service Worker登録
// ============================================================

let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('install-banner').style.display = 'flex';
});

document.getElementById('install-btn').addEventListener('click', async () => {
  document.getElementById('install-banner').style.display = 'none';
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
