/** Every cozy-client query of the server: definitions, aliases and fetch policy. */
import { Q } from 'cozy-client';

export const FILES_DOCTYPE = 'io.cozy.files';
export const TRASH_DIR_ID = 'io.cozy.files.trash-dir';

// An assistant reads its own writes right away, so a query never answers from the store.
const fetchPolicy = () => true;

export const buildDiskUsageQuery = () => ({
  definition: Q('io.cozy.settings').getById('io.cozy.settings.disk-usage'),
  options: { as: 'io.cozy.settings/io.cozy.settings.disk-usage', fetchPolicy },
});
