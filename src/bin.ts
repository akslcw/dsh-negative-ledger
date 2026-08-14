#!/usr/bin/env node
/**
 * CLI bin entry: parses argv and prints the ledger report.
 * @module dsh-negative-ledger/bin
 */

import { main } from './cli.ts'

void main(process.argv.slice(2))
