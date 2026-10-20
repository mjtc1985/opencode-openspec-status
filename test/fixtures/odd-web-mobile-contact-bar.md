# Mobile contact bar and home hero CTA

## Objective

Raise contact rate on mobile by keeping the contact options in sight.

## Problem

Most mobile visitors never scroll far enough to see a phone number or a chat
  link. The landing page with a contact button in the hero converts twice as
  well as the home page.

## Why

Contact is the only conversion that matters for the site.

## Scope (authorized)

- A fixed bottom bar on mobile with two buttons: Chat and Call, with their own
  element ids so analytics can tell them apart.
- A contact button in the home hero, styled like the landing page one.

## Constraints

- Do not click the live links during verification: it would log fake contacts.

## TDD

Off. Source: no project configuration. Runner: none (manual checks).

## Tasks
- [x] T1 Mobile contact bar (route: inline; one non-trivial resource, snippet #36)
- [x] T2 Home hero CTA (route: inline; mechanical copy of the landing page button
      into the home page)
- [x] T3 Record both changes in `analytics/data/changes.yaml` (done inside the T1 and
      T2 commits, one entry each, so every commit carries its own record)

## Acceptance criteria

- The bar shows on mobile only, at the bottom, both links correct, ids present.

## Progress / evidence

- T1: ✅ bar live, ids present.
- T2: ✅ hero button live.

## Next step

Measure after one full week: chat_contact and phone_contact by link_id bar_chat / bar_call, and home contact rate. Push and merge of feat/mobile-contact-bar are the owner's decision.
