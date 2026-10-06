#!/usr/bin/env node
// A stand-in for the higgsfield CLI: never talks to the network. Behaviour comes from FAKE_HF_* env.
import fs from 'node:fs'
const args = process.argv.slice(2)
const creds = process.env.HIGGSFIELD_CREDENTIALS_PATH
const log = process.env.FAKE_HF_LOG
if (log) fs.appendFileSync(log, JSON.stringify({ args, creds }) + '\n')
if (process.env.FAKE_HF_DELETE_CREDS === '1' && creds) fs.rmSync(creds, { force: true })
const cmd = args.slice(0, 2).join(' ')
if (cmd === 'account status') process.stdout.write(JSON.stringify({ email: process.env.FAKE_HF_EMAIL ?? 'a@x.com', credits: Number(process.env.FAKE_HF_CREDITS ?? 100) }))
else if (cmd === 'generate cost') process.stdout.write(JSON.stringify({ credits: Number(process.env.FAKE_HF_COST ?? 5) }))
else if (cmd === 'upload create') process.stdout.write(JSON.stringify({ id: '11111111-1111-4111-8111-111111111111' }))
else if (cmd === 'generate create') process.stdout.write(JSON.stringify({ id: '22222222-2222-4222-8222-222222222222' }))
else process.stdout.write('ok ' + args.join(' '))
process.exit(Number(process.env.FAKE_HF_EXIT ?? 0))
