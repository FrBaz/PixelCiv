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
 */
import type { InspectTarget, WorkerMessage } from '../core/protocol';
import type { Sheet } from '../ui/store';

type Inspection = Extract<WorkerMessage, { type: 'inspection' }>;

/** Demande à envoyer au worker, avec son numéro. */
export interface SheetRequest {
  readonly requestId: number;
  readonly target: InspectTarget;
}

export class SheetRequests {
  /** Numéros de la dernière demande envoyée, et de la dernière réponse reçue. */
  private sent = 0;
  private answered = 0;
  /** Les réponses de numéro inférieur sont ignorées. */
  private floor = 1;
  /** Cible de la fiche ouverte, ou que le joueur vient de demander. */
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
    this.target = undefined;
    this.floor = this.sent + 1;
  }

  /**
   * Réponse du worker : la fiche à montrer ; null si elle doit se fermer, sa cible
   * n'existant plus (un groupe éteint) ; undefined si la réponse est à ignorer.
   */
  receive(message: Inspection): Sheet | null | undefined {
    this.answered = Math.max(this.answered, message.requestId);
    if (message.requestId < this.floor || this.target === undefined) return undefined;
    if (message.person !== undefined) {
      this.target = { kind: 'person', id: message.person.id };
      return { kind: 'person', view: message.person };
    }
    if (message.group !== undefined) {
      this.target = { kind: 'group', id: message.group.id };
      return { kind: 'group', view: message.group };
    }
    this.target = undefined;
    return null;
  }

  private next(target: InspectTarget): SheetRequest {
    this.sent++;
    return { requestId: this.sent, target };
  }
}
