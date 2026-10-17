import * as files from './transaction-files.js';
import type { TransactionArea, TransactionJournal } from './types.js';

// ---------------------------------------------------------------------------
// The transaction aggregate — a family migration's rehearsal, each owner's
// journal, and the staged bytes and backups beside it — as the Repository
// pattern holds it, shaped like the externals Repository:
//
// transaction_store — the read-through Store: every read is the file read
// through the transaction file adapter and nothing is held in memory, which is
// the point: after a crash the files ARE the state, and doctor reads them with
// nothing else to go on. There is therefore nothing to hydrate.
//
// transaction_repository — the facade consumers use; every method forwards
// 1:1 to the Store. No Registry or Index: the aggregate is written by one
// workflow (family_transaction) in a fixed protocol and read by the same
// workflow at recovery, one journal at a time.
// ---------------------------------------------------------------------------

/** itransaction_store / itransaction_repository — the one contract shape both faces share. */
export interface TransactionAccess {
  openRehearsal(id: string): string;
  dropRehearsal(id: string): void;
  saveJournal(journal: TransactionJournal): void;
  readJournal(owner: string, id: string): TransactionJournal | null;
  listJournals(owner: string): TransactionJournal[];
  putFile(owner: string, id: string, area: TransactionArea, path: string, bytes: Uint8Array): void;
  readFile(owner: string, id: string, area: TransactionArea, path: string): Buffer | null;
  locate(owner: string, id: string, area: TransactionArea, path: string): string;
  close(owner: string, id: string): void;
}

/** transaction_store — each method one file operation through the transaction file adapter. */
export const transactionStore: TransactionAccess = {
  openRehearsal(id) {
    return files.openRehearsal(id);
  },
  dropRehearsal(id) {
    files.dropRehearsal(id);
  },
  saveJournal(journal) {
    files.saveJournal(journal);
  },
  readJournal(owner, id) {
    return files.readJournal(owner, id);
  },
  listJournals(owner) {
    return files.listJournals(owner);
  },
  putFile(owner, id, area, path, bytes) {
    files.putFile(owner, id, area, path, bytes);
  },
  readFile(owner, id, area, path) {
    return files.readFile(owner, id, area, path);
  },
  locate(owner, id, area, path) {
    return files.locate(owner, id, area, path);
  },
  close(owner, id) {
    files.close(owner, id);
  },
};

/** transaction_repository — the facade: each method one forward to the store. */
export const transactionRepository: TransactionAccess = {
  openRehearsal(id) {
    return transactionStore.openRehearsal(id);
  },
  dropRehearsal(id) {
    transactionStore.dropRehearsal(id);
  },
  saveJournal(journal) {
    transactionStore.saveJournal(journal);
  },
  readJournal(owner, id) {
    return transactionStore.readJournal(owner, id);
  },
  listJournals(owner) {
    return transactionStore.listJournals(owner);
  },
  putFile(owner, id, area, path, bytes) {
    transactionStore.putFile(owner, id, area, path, bytes);
  },
  readFile(owner, id, area, path) {
    return transactionStore.readFile(owner, id, area, path);
  },
  locate(owner, id, area, path) {
    return transactionStore.locate(owner, id, area, path);
  },
  close(owner, id) {
    transactionStore.close(owner, id);
  },
};
