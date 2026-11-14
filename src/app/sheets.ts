/**
 * Demandes de fiche (IHM-02) : celles du joueur, qui ouvre une fiche ou suit un lien, et
 * les rafraîchissements de la fiche ouverte, qui suit la vie de l'individu ou du groupe.
 *
 * Chaque demande a son numéro, que la réponse reprend. Une réponse n'est retenue que si
 * elle répond à la dernière demande du joueur, ou à un rafraîchissement venu après elle :
 * - une réponse antérieure à une demande du joueur, à la fermeture de la fiche ou à un
 *   changement de partie est ignorée : elle porte sur une autre cible, ou un autre monde,
 *   où les mêmes identifiants désignent d'autres gens ;
 * - un rafraîchissement ne part que si une fiche est ouverte et qu'aucune réponse n'est
 *   attendue : il ne passe jamais devant une demande du joueur, et une fiche fermée ne se
 *   rouvre pas d'elle-même.
 *
 * Une réponse vide dit que sa cible n'existe plus, comme un groupe éteint ou réuni à un
 * autre. Si c'est celle de la fiche montrée, la fiche se ferme. Si le joueur demandait une
 * autre cible, depuis un fait de la chronique par exemple, la fiche montrée reste ouverte,
 * ses rafraîchissements aussi, et un avis dit pourquoi rien ne s'ouvre. Sur petit écran,
 * la fiche que le joueur demande passe au-dessus à sa réponse, et non dès la demande : une
 * cible qui n'est plus ne fait pas passer la fiche en cours devant le panneau où il l'a
 * demandée.
 */
import type { InspectTarget, WorkerMessage } from '../core/protocol';
import type { MessageKey } from '../i18n';
import type { Sheet } from '../ui/store';

type Inspection = Extract<WorkerMessage, { type: 'inspection' }>;

/** Demande à envoyer au worker, avec son numéro. */
export interface SheetRequest {
  readonly requestId: number;
  readonly target: InspectTarget;
}

/** Ce que change une réponse du worker. */
export type SheetAnswer =
  /** Réponse dépassée (autre cible, autre partie, fiche fermée) : rien ne change. */
  | { readonly type: 'ignored' }
  /**
   * La fiche à montrer. `requested` : elle répond à une demande du joueur, et passe alors
   * au-dessus des autres panneaux sur petit écran, même si elle était déjà ouverte.
   */
  | { readonly type: 'shown'; readonly sheet: Sheet; readonly requested: boolean }
  /**
   * La cible n'existe plus. `close` : c'était celle de la fiche montrée, qui se ferme ;
   * sinon, la fiche montrée reste. `notice` : l'avis à montrer, si le joueur l'avait demandée.
   */
  | {
      readonly type: 'missing';
      readonly close: boolean;
      readonly notice: MessageKey | undefined;
    };

/** Avis d'une cible demandée qui n'existe plus, selon sa sorte. */
const MISSING: Readonly<Record<InspectTarget['kind'], MessageKey>> = {
  person: 'sheet.missing.person',
  group: 'sheet.missing.group',
};

function sameTarget(a: InspectTarget, b: InspectTarget): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export class SheetRequests {
  /** Numéros de la dernière demande envoyée, et de la dernière réponse reçue. */
  private sent = 0;
  private answered = 0;
  /**
   * Les réponses de numéro inférieur sont ignorées : c'est le numéro de la dernière demande
   * du joueur, ou de la prochaine demande après une fermeture.
   */
  private floor = 1;
  /** Cible de la fiche montrée, ou undefined si aucune ne l'est. */
  private shown: InspectTarget | undefined;
  /** Cible des demandes : celle que le joueur vient de demander, ou celle de la fiche montrée. */
  private target: InspectTarget | undefined;

  /** Le joueur demande une fiche : la demande à envoyer. */
  open(target: InspectTarget): SheetRequest {
    this.target = target;
    this.floor = this.sent + 1;
    return this.next(target);
  }

  /**
   * Rafraîchissement de la fiche ouverte : la demande à envoyer, ou undefined si aucune
   * fiche n'est ouverte, ou si une réponse est attendue.
   */
  refresh(): SheetRequest | undefined {
    if (this.target === undefined || this.answered < this.sent) return undefined;
    return this.next(this.target);
  }

  /** La fiche se ferme, ou la partie change : toute réponse attendue sera ignorée. */
  close(): void {
    this.shown = undefined;
    this.target = undefined;
    this.floor = this.sent + 1;
  }

  /** Réponse du worker : ce qu'elle change à la fiche. */
  receive(message: Inspection): SheetAnswer {
    this.answered = Math.max(this.answered, message.requestId);
    const target = this.target;
    if (message.requestId < this.floor || target === undefined) return { type: 'ignored' };
    // La demande du joueur porte le numéro `floor` ; ceux d'après sont des rafraîchissements.
    const requested = message.requestId === this.floor;
    const sheet: Sheet | undefined =
      message.person !== undefined
        ? { kind: 'person', view: message.person }
        : message.group !== undefined
          ? { kind: 'group', view: message.group }
          : undefined;
    if (sheet !== undefined) {
      this.shown = { kind: sheet.kind, id: sheet.view.id };
      this.target = this.shown;
      return { type: 'shown', sheet, requested };
    }
    const notice = requested ? MISSING[target.kind] : undefined;
    if (this.shown === undefined || !sameTarget(this.shown, target)) {
      // Le joueur demandait une autre cible que celle de la fiche montrée, s'il y en a une :
      // cette fiche reste, et se rafraîchit.
      this.target = this.shown;
      return { type: 'missing', close: false, notice };
    }
    // La cible de la fiche montrée n'est plus : la fiche se ferme.
    this.shown = undefined;
    this.target = undefined;
    return { type: 'missing', close: true, notice };
  }

  private next(target: InspectTarget): SheetRequest {
    this.sent++;
    return { requestId: this.sent, target };
  }
}
