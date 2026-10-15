#!/usr/bin/env node
// Stand-in for Eva's Arc exporter in tests: prints synthetic cookies only.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
if (process.env.ARC_FIXTURE_MARK) fs.writeFileSync(process.env.ARC_FIXTURE_MARK, 'ran\n')
process.stdout.write(fs.readFileSync(path.join(dir, 'arc-cookies.fixture.json'), 'utf8'))
