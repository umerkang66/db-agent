import readline from 'node:readline';
import chalk from 'chalk';
import boxen from 'boxen';
import { SafetyClassification } from './classifier.js';
import { ExecutableQuery } from '../db/adapter.js';

export interface ConfirmationResult {
  confirmed: boolean;
  reason?: string;
}

export type AskQuestionFn = (prompt: string) => Promise<string>;

export async function defaultAsk(promptText: string): Promise<string> {
  process.stdin.resume();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      process.stdin.resume();
      resolve(answer);
    });
  });
}

export async function promptConfirm(
  message: string,
  defaultValue: boolean,
  ask: AskQuestionFn = defaultAsk
): Promise<boolean> {
  const suffix = defaultValue ? chalk.gray(' (Y/n): ') : chalk.gray(' (y/N): ');
  const response = (await ask(`${message}${suffix}`)).trim().toLowerCase();
  if (!response) {
    return defaultValue;
  }
  if (['y', 'yes', 'true', '1'].includes(response)) {
    return true;
  }
  if (['n', 'no', 'false', '0'].includes(response)) {
    return false;
  }
  return defaultValue;
}

export async function promptInput(
  message: string,
  ask: AskQuestionFn = defaultAsk
): Promise<string> {
  const response = await ask(message);
  return response.trim();
}

export async function requestUserConfirmation(
  query: ExecutableQuery,
  safety: SafetyClassification,
  affectedRows: number | null,
  ask: AskQuestionFn = defaultAsk
): Promise<ConfirmationResult> {
  const queryDisplay = (query.sql || query.rawDisplay || '').trim();

  // 1. FULL WIPE
  if (safety.isFullWipe) {
    const boxContent = [
      chalk.bold.red('🚨 CRITICAL: FULL DATABASE / ALL TABLES WIPE ATTEMPTED 🚨'),
      '',
      chalk.yellow(queryDisplay),
      '',
      ...(safety.warnings.length ? [chalk.red(safety.warnings.join('\n')), ''] : []),
      chalk.bold.white(`Type ${chalk.red.underline(safety.literalWord || 'DROP DATABASE')} to proceed:`),
    ].join('\n');

    console.log(
      boxen(boxContent, {
        padding: 1,
        borderColor: 'red',
        borderStyle: 'double',
        margin: { top: 1, bottom: 1 },
      })
    );

    const typed = await promptInput(
      chalk.red.bold(`Type "${safety.literalWord || 'DROP DATABASE'}" to confirm full wipe: `),
      ask
    );

    if (typed.trim() === safety.literalWord) {
      return { confirmed: true };
    }
    return {
      confirmed: false,
      reason: `Confirmation word mismatch (expected "${safety.literalWord}"). Operation aborted.`,
    };
  }

  // 2. DANGEROUS OPERATION (missing WHERE, DROP, TRUNCATE, ALTER DROP, or large mutation)
  if (safety.category === 'dangerous') {
    const lines = [
      chalk.bold.hex('#FFA500')('⚠️  DANGEROUS OPERATION'),
      '',
      chalk.white(queryDisplay),
      '',
    ];

    if (affectedRows !== null) {
      lines.push(
        chalk.bold.yellow(`Affected rows: ${affectedRows.toLocaleString()}`),
        ''
      );
    }

    if (safety.warnings.length > 0) {
      for (const w of safety.warnings) {
        lines.push(chalk.red(`• ${w}`));
      }
      lines.push('');
    }

    console.log(
      boxen(lines.join('\n'), {
        padding: 1,
        borderColor: 'yellow',
        borderStyle: 'round',
        margin: { top: 1, bottom: 1 },
      })
    );

    // If literal word is required (e.g. no WHERE clause: DELETE ALL, UPDATE ALL, DROP TABLE)
    if (safety.requiresLiteralWord && safety.literalWord) {
      const typed = await promptInput(
        chalk.hex('#FFA500').bold(
          `Destructive operation with no filter. Type "${safety.literalWord}" to confirm: `
        ),
        ask
      );

      if (typed.trim() === safety.literalWord) {
        return { confirmed: true };
      }
      return {
        confirmed: false,
        reason: `Confirmation word mismatch (expected "${safety.literalWord}"). Operation cancelled.`,
      };
    }

    // Otherwise standard y/N with dangerous prompt
    const answer = await promptConfirm(
      chalk.hex('#FFA500').bold('Proceed with dangerous operation?'),
      false,
      ask
    );

    return { confirmed: answer };
  }

  // 3. STRUCTURAL OPERATION (DDL: CREATE TABLE, CREATE INDEX, ALTER ADD, createCollection)
  if (safety.isStructural) {
    const lines = [
      chalk.bold.cyan('🛠️  STRUCTURAL DDL OPERATION'),
      '',
      chalk.white(queryDisplay),
      '',
      chalk.cyan(`Effect: ${safety.explanation || 'Modifies database structure.'}`),
    ];

    if (safety.suggestedAlternative) {
      lines.push(
        '',
        chalk.yellow('💡 Recommendation:'),
        chalk.gray(safety.suggestedAlternative)
      );
    }

    if (safety.warnings.length > 0) {
      lines.push('');
      for (const w of safety.warnings) {
        lines.push(chalk.yellow(`• ${w}`));
      }
    }

    console.log(
      boxen(lines.join('\n'), {
        padding: 1,
        borderColor: 'cyan',
        borderStyle: 'round',
        margin: { top: 1, bottom: 1 },
      })
    );

    const answer = await promptConfirm(
      chalk.cyan.bold('Apply this structural change?'),
      true,
      ask
    );

    return { confirmed: answer };
  }

  // 4. WRITE OPERATION (INSERT, filtered UPDATE)
  if (safety.category === 'write') {
    const lines = [
      chalk.bold.magenta('✏️  DATABASE WRITE OPERATION'),
      '',
      chalk.white(queryDisplay),
    ];

    if (affectedRows !== null) {
      lines.push('', chalk.magenta(`Estimated affected rows: ${affectedRows.toLocaleString()}`));
    }

    console.log(
      boxen(lines.join('\n'), {
        padding: 1,
        borderColor: 'magenta',
        borderStyle: 'round',
        margin: { top: 1, bottom: 1 },
      })
    );

    const answer = await promptConfirm(
      chalk.magenta.bold('Execute write query?'),
      false,
      ask
    );

    return { confirmed: answer };
  }

  // 5. READ OPERATION (SELECT, find, aggregate)
  const lines = [
    chalk.bold.green('🔍 READ QUERY'),
    '',
    chalk.white(queryDisplay),
  ];

  console.log(
    boxen(lines.join('\n'), {
      padding: 1,
      borderColor: 'green',
      borderStyle: 'round',
      margin: { top: 1, bottom: 1 },
    })
  );

  const answer = await promptConfirm(
    chalk.green.bold('Execute read query?'),
    true,
    ask
  );

  return { confirmed: answer };
}
