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

/** Ce que montre la fiche après une réponse : cible, fermeture (null) ou rien (ignorée). */
function shown(requests: SheetRequests, message: Inspection) {
  const sheet = requests.receive(message);
  return sheet === null || sheet === undefined ? sheet : `${sheet.kind} ${String(sheet.view.id)}`;
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

  it("ferme la fiche d'un groupe qui n'est plus, et reprend après une réponse perdue", () => {
    const requests = new SheetRequests();
    expect(shown(requests, answer(requests.open({ kind: 'group', id: 4 })))).toBe('group 4');
    expect(shown(requests, answer(requests.refresh(), false))).toBeNull();
    expect(requests.refresh()).toBeUndefined();
    // Une réponse ignorée compte comme reçue : les rafraîchissements reprennent ensuite.
    const lost = requests.open({ kind: 'group', id: 5 });
    const next = requests.open({ kind: 'group', id: 6 });
    expect(shown(requests, answer(next))).toBe('group 6');
    expect(shown(requests, answer(lost))).toBeUndefined();
    expect(requests.refresh()?.target).toEqual({ kind: 'group', id: 6 });
  });
});
