/** Date de la partie, telle qu'on l'affiche : « mars de l'an 12 ». */
import { dateOfTick } from '../core/time';
import { t, type MessageKey } from '../i18n';

/** Noms des mois, de janvier à décembre. */
export const MONTH_KEYS = [
  'calendar.month.january',
  'calendar.month.february',
  'calendar.month.march',
  'calendar.month.april',
  'calendar.month.may',
  'calendar.month.june',
  'calendar.month.july',
  'calendar.month.august',
  'calendar.month.september',
  'calendar.month.october',
  'calendar.month.november',
  'calendar.month.december',
] as const satisfies readonly MessageKey[];

export function formatDate(tick: number): string {
  const { year, month } = dateOfTick(tick);
  return t('calendar.date', { month: t(MONTH_KEYS[month] ?? MONTH_KEYS[0]), year });
}
