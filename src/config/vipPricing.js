/**
 * Precios y conversión VIP centralizados.
 * USD 5 = 30 días de membresía. Recargas parciales usan la misma tasa.
 */

const MONTHLY_USD = Number(process.env.VIP_MONTHLY_USD || 5);
const WEEKLY_USD = Number(process.env.VIP_WEEKLY_USD || 2.5);
const MONTHLY_DAYS = Number(process.env.VIP_MONTHLY_DAYS || 30);
const WEEKLY_DAYS = Number(process.env.VIP_WEEKLY_DAYS || 7);
const MIN_TOPUP_USD = Number(process.env.VIP_MIN_TOPUP_USD || 1);
/** Tasa fallback COP/USD si PayMatuByte no responde. */
const FALLBACK_COP_PER_USD = Number(process.env.VIP_COP_PER_USD || 4000);

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

function monthlyUsd() {
  return MONTHLY_USD > 0 ? MONTHLY_USD : 5;
}

function weeklyUsd() {
  return WEEKLY_USD > 0 ? WEEKLY_USD : 2.5;
}

function monthlyDays() {
  return MONTHLY_DAYS > 0 ? MONTHLY_DAYS : 30;
}

function weeklyDays() {
  return WEEKLY_DAYS > 0 ? WEEKLY_DAYS : 7;
}

function minTopupUsd() {
  return MIN_TOPUP_USD > 0 ? MIN_TOPUP_USD : 1;
}

/** Minutos VIP por USD (proporcional al plan mensual). */
function minutesPerUsd() {
  return (monthlyDays() * 24 * 60) / monthlyUsd();
}

function minutesForUsd(amountUsd) {
  const usd = Number(amountUsd);
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.max(1, Math.round(usd * minutesPerUsd()));
}

function minutesForPlan(plan) {
  if (plan === "weekly") return weeklyDays() * 24 * 60;
  if (plan === "annual") return 365 * 24 * 60;
  return monthlyDays() * 24 * 60;
}

function usdForPlan(plan) {
  if (plan === "weekly") return weeklyUsd();
  if (plan === "annual") return monthlyUsd() * 10;
  return monthlyUsd();
}

function estimateCop(amountUsd, rate = FALLBACK_COP_PER_USD) {
  const usd = Number(amountUsd);
  const r = Number(rate) > 0 ? Number(rate) : FALLBACK_COP_PER_USD;
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * r);
}

function formatVipDuration(totalMinutes) {
  const mins = Math.max(0, Math.floor(Number(totalMinutes) || 0));
  const days = Math.floor(mins / (24 * 60));
  const hours = Math.floor((mins % (24 * 60)) / 60);
  const minutes = mins % 60;
  return { days, hours, minutes, totalMinutes: mins };
}

function publicPricing(copPerUsd = FALLBACK_COP_PER_USD) {
  const rate = Number(copPerUsd) > 0 ? Number(copPerUsd) : FALLBACK_COP_PER_USD;
  return {
    monthlyUsd: monthlyUsd(),
    weeklyUsd: weeklyUsd(),
    monthlyDays: monthlyDays(),
    weeklyDays: weeklyDays(),
    minTopupUsd: minTopupUsd(),
    minutesPerUsd: minutesPerUsd(),
    copPerUsd: rate,
    topupPresetsUsd: [1, 2, 5, 10, 20],
    plans: {
      weekly: {
        id: "weekly",
        usd: weeklyUsd(),
        days: weeklyDays(),
        minutes: minutesForPlan("weekly"),
        cop: estimateCop(weeklyUsd(), rate),
        regularUsd: weeklyUsd() * 2,
      },
      monthly: {
        id: "monthly",
        usd: monthlyUsd(),
        days: monthlyDays(),
        minutes: minutesForPlan("monthly"),
        cop: estimateCop(monthlyUsd(), rate),
        regularUsd: monthlyUsd() * 2,
      },
    },
  };
}

module.exports = {
  monthlyUsd,
  weeklyUsd,
  monthlyDays,
  weeklyDays,
  minTopupUsd,
  minutesPerUsd,
  minutesForUsd,
  minutesForPlan,
  usdForPlan,
  estimateCop,
  formatVipDuration,
  publicPricing,
  FALLBACK_COP_PER_USD,
  MS_PER_DAY,
  MS_PER_MINUTE,
};
