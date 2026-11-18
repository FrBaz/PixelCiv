/**
 * Date de la partie, telle qu'on l'affiche : « mars de l'an 12 » pour la chronique et les
 * fiches, datées du mois, et « 12 mars de l'an 3 » pour le contrôle du temps (ADR 0013).
 */
import { dateOfTick, dateOfTime, type GameTime } from '../core/time';
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
  const name = t(MONTH_KEYS[month] ?? MONTH_KEYS[0]);
  // Avant l'an 1 : un individu apparu adulte est né avant le début de la partie.
  if (year <= 0) return t('calendar.dateBefore', { month: name, count: 1 - year });
  // Une année s'écrit sans séparateur de milliers : l'an 2000, et non l'an 2 000.
  return t('calendar.date', { month: name, year: String(year) });
}

/**
 * Date d'un instant, au jour près : le jour en cours de son mois, « 12 mars de l'an 3 »,
 * et « 1er mars de l'an 3 » pour le premier. La partie commence à l'an 1 : un instant
 * d'avant n'a que son mois.
 */
export function formatDay(time: GameTime): string {
  const { year, month, day } = dateOfTime(time);
  if (year <= 0) return formatDate(time.tick);
  const name = t(MONTH_KEYS[month] ?? MONTH_KEYS[0]);
  if (day === 1) return t('calendar.dayDateFirst', { month: name, year: String(year) });
  return t('calendar.dayDate', { day: String(day), month: name, year: String(year) });
}
