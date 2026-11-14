import { describe, expect, it } from 'vitest';
import type { GroupView, PersonView, WorkerMessage } from '../core/protocol';
import { SheetRequests, type SheetRequest } from './sheets';

type Inspection = Extract<WorkerMessage, { type: 'inspection' }>;

/** Réponse du worker à une demande : la fiche de sa cible, ou rien si elle n'existe plus. */
function answer(request: SheetRequest | undefined, exists = true): Inspection {
  if (request === undefined) throw new Error('aucune demande envoyée');
  const { requestId, target } = request;
  if (!exists) return { type: 'inspection', requestId };
  return target.kind === 'person'
    ? { type: 'inspection', requestId, person: { id: target.id } as PersonView }
    : { type: 'inspection', requestId, group: { id: target.id } as GroupView };
}

/**
 * Ce que montre la fiche après une réponse : sa cible, sa fermeture (null), ou rien de
 * nouveau (undefined : réponse ignorée, ou fiche en cours gardée).
 */
function shown(requests: SheetRequests, message: Inspection) {
  const answer = requests.receive(message);
  if (answer.type === 'shown') return `${answer.sheet.kind} ${String(answer.sheet.view.id)}`;
  return answer.type === 'missing' && answer.close ? null : undefined;
}

describe('demandes de fiche (IHM-02)', () => {
  it("montre la fiche demandée par le joueur, puis la rafraîchit tant qu'elle est ouverte", () => {
    const requests = new SheetRequests();
    expect(requests.refresh()).toBeUndefined();
    const open = requests.open({ kind: 'group', id: 3 });
    // Une réponse attendue : pas de rafraîchissement par-dessus.
    expect(requests.refresh()).toBeUndefined();
    expect(shown(requests, answer(open))).toBe('group 3');
    const refresh = requests.refresh();
    expect(refresh?.target).toEqual({ kind: 'group', id: 3 });
    expect(shown(requests, answer(refresh))).toBe('group 3');
  });

  it('ne laisse pas un rafraîchissement annuler le lien suivi par le joueur (W-5, U-1)', () => {
    const requests = new SheetRequests();
    expect(shown(requests, answer(requests.open({ kind: 'group', id: 2 })))).toBe('group 2');
    // Un rafraîchissement part ; le joueur suit le lien d'une mère avant sa réponse.
    const refresh = requests.refresh();
    const click = requests.open({ kind: 'person', id: 26 });
    // Rien ne part tant que le clic attend sa réponse.
    expect(requests.refresh()).toBeUndefined();
    expect(shown(requests, answer(refresh))).toBeUndefined();
    expect(shown(requests, answer(click))).toBe('person 26');
    // Le rafraîchissement suit désormais la fiche choisie.
    expect(requests.refresh()?.target).toEqual({ kind: 'person', id: 26 });
  });

  it('garde le dernier de deux liens suivis coup sur coup', () => {
    const requests = new SheetRequests();
    const first = requests.open({ kind: 'person', id: 1 });
    const second = requests.open({ kind: 'person', id: 2 });
    expect(shown(requests, answer(first))).toBeUndefined();
    expect(shown(requests, answer(second))).toBe('person 2');
  });

  it("ne rouvre pas une fiche fermée pendant qu'une réponse était en route (W-5)", () => {
    const requests = new SheetRequests();
    expect(shown(requests, answer(requests.open({ kind: 'person', id: 7 })))).toBe('person 7');
    const refresh = requests.refresh();
    requests.close();
    expect(shown(requests, answer(refresh))).toBeUndefined();
    expect(requests.refresh()).toBeUndefined();
  });

  it('ignore une réponse arrivée après un changement de partie (W-4)', () => {
    const requests = new SheetRequests();
    expect(shown(requests, answer(requests.open({ kind: 'person', id: 1 })))).toBe('person 1');
    // Le rafraîchissement part avant l'instantané de la partie chargée, mais le worker n'y
    // répond qu'après : l'individu 1 de la nouvelle partie est un autre.
    const refresh = requests.refresh();
    requests.close();
    expect(shown(requests, answer(refresh))).toBeUndefined();
    // Une demande faite dans la nouvelle partie se montre.
    expect(shown(requests, answer(requests.open({ kind: 'person', id: 1 })))).toBe('person 1');
  });

  it('dit si la fiche montrée répond au joueur, qui la remonte, ou à un rafraîchissement', () => {
    const requests = new SheetRequests();
    const open = requests.receive(answer(requests.open({ kind: 'group', id: 3 })));
    expect(open).toMatchObject({ type: 'shown', requested: true });
    expect(requests.receive(answer(requests.refresh()))).toMatchObject({ requested: false });
    // La même fiche demandée de nouveau, comme un fait touché deux fois : elle remonte.
    const again = requests.receive(answer(requests.open({ kind: 'group', id: 3 })));
    expect(again).toMatchObject({ type: 'shown', requested: true });
  });

  it("ferme la fiche d'un groupe qui n'est plus, et reprend après une réponse perdue", () => {
    const requests = new SheetRequests();
    expect(shown(requests, answer(requests.open({ kind: 'group', id: 4 })))).toBe('group 4');
    // Un rafraîchissement sans cible ferme la fiche, sans avis : le joueur n'a rien demandé.
    const gone = requests.receive(answer(requests.refresh(), false));
    expect(gone).toEqual({ type: 'missing', close: true, notice: undefined });
    expect(requests.refresh()).toBeUndefined();
    // Une réponse ignorée compte comme reçue : les rafraîchissements reprennent ensuite.
    const lost = requests.open({ kind: 'group', id: 5 });
    const next = requests.open({ kind: 'group', id: 6 });
    expect(shown(requests, answer(next))).toBe('group 6');
    expect(shown(requests, answer(lost))).toBeUndefined();
    expect(requests.refresh()?.target).toEqual({ kind: 'group', id: 6 });
  });

  it("garde la fiche en cours quand le joueur demande un groupe qui n'est plus (W-5, U-1)", () => {
    const requests = new SheetRequests();
    expect(shown(requests, answer(requests.open({ kind: 'person', id: 7 })))).toBe('person 7');
    expect(shown(requests, answer(requests.refresh()))).toBe('person 7');
    // Un appui sur un fait de la chronique : le groupe 9, réuni à un voisin, n'est plus.
    const merged = requests.receive(answer(requests.open({ kind: 'group', id: 9 }), false));
    expect(merged).toEqual({ type: 'missing', close: false, notice: 'sheet.missing.group' });
    // La fiche de l'individu reste ouverte, et se rafraîchit encore.
    const refresh = requests.refresh();
    expect(refresh?.target).toEqual({ kind: 'person', id: 7 });
    expect(shown(requests, answer(refresh))).toBe('person 7');
    // Un individu introuvable a son propre avis.
    const unknown = requests.receive(answer(requests.open({ kind: 'person', id: 99 }), false));
    expect(unknown).toEqual({ type: 'missing', close: false, notice: 'sheet.missing.person' });
    expect(requests.refresh()?.target).toEqual({ kind: 'person', id: 7 });
  });

  it("dit qu'un groupe demandé n'est plus, fiche fermée ou montrant ce groupe", () => {
    const requests = new SheetRequests();
    // Aucune fiche ouverte : rien ne s'ouvre, un avis le dit, et rien ne se rafraîchit.
    const none = requests.receive(answer(requests.open({ kind: 'group', id: 9 }), false));
    expect(none).toEqual({ type: 'missing', close: false, notice: 'sheet.missing.group' });
    expect(requests.refresh()).toBeUndefined();
    // La fiche du groupe 4 est ouverte, et le joueur la redemande quand il vient de s'éteindre.
    expect(shown(requests, answer(requests.open({ kind: 'group', id: 4 })))).toBe('group 4');
    const extinct = requests.receive(answer(requests.open({ kind: 'group', id: 4 }), false));
    expect(extinct).toEqual({ type: 'missing', close: true, notice: 'sheet.missing.group' });
    expect(requests.refresh()).toBeUndefined();
  });
});
