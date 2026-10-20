// Most UI assertions were written against the Spanish strings, so the suite runs
// with the Spanish locale by default. test/view/english.test.ts switches to
// English for its own cases.
import { setLocale } from "../src/i18n.ts"

setLocale("es")
