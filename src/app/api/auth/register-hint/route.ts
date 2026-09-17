import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

/** Lets the signup form know, BEFORE submit, whether this device's next
 *  account needs an email (a second+ signup on the same browser does).
 *  Deliberately says nothing about why — the field just appears, required. */
export async function GET() {
  const store = await cookies()
  const priorAccounts = Number(store.get('hc_accounts_made')?.value ?? '0') || 0
  return NextResponse.json({ emailRequired: priorAccounts > 0 })
}
