import { existsSync } from 'node:fs';
import { CommandError, listUsers, makeAdmin, resetPassword } from './admin/commands.js';
import { loadConfig } from './config.js';
import { configPaths } from './config-dir.js';
import { openDatabase } from './db/index.js';

const USAGE = `Usage: offbeat <command>

  reset-password <username>   Make a new temporary password (shown once, works for 7 days).
                              The user chooses their own at next sign-in and is signed out everywhere.
  list-users                  Everyone who can sign in, with their role.
  make-admin <username>       Make a user an admin, for when no admin can sign in.

Reads the same CONFIG_DIR as the server, and works while Offbeat is running.
In Docker: docker exec -it offbeat offbeat reset-password <username>`;

async function main(args: string[]): Promise<number> {
  const [command, username, ...extra] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  const needsName = command === 'reset-password' || command === 'make-admin';
  if ((needsName && (!username || extra.length)) || (command === 'list-users' && username)) {
    console.error(USAGE);
    return 2;
  }
  if (!['reset-password', 'list-users', 'make-admin'].includes(command)) {
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }

  // Never create a new, empty database by accident (for example with the wrong CONFIG_DIR).
  const { database } = configPaths(loadConfig().configDir);
  if (!existsSync(database)) {
    console.error(`No Offbeat database at ${database}. Set CONFIG_DIR to Offbeat's config folder.`);
    return 1;
  }
  const db = openDatabase(database);
  try {
    if (command === 'list-users') {
      for (const user of listUsers(db)) {
        const seen = user.lastSeenAt ? `last seen ${user.lastSeenAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'never signed in';
        console.log(`${user.username.padEnd(32)} ${(user.role === 'admin' ? 'Admin' : 'Member').padEnd(7)} ${seen}`);
      }
      return 0;
    }
    if (command === 'make-admin') {
      const result = makeAdmin(db, username!);
      console.log(result.changed ? `${result.username} is now an admin.` : `${result.username} is already an admin.`);
      return 0;
    }
    const result = await resetPassword(db, username!);
    console.log(`Temporary password for ${result.username}: ${result.password}`);
    console.log(`It works until ${result.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC and is shown only now.`);
    console.log(`${result.username} will choose their own password at next sign-in, and was signed out everywhere.`);
    return 0;
  } catch (error) {
    if (error instanceof CommandError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    db.$client.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
