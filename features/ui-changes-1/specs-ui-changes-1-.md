## Specifications for UI changes for phase-1

## website and mobile both
1. Remove the term `visa experiences` to `USA visits/migration journey` in all the places
2. Remove the page [community](./community). There is no community to join. There is a group to join which is separate functionality. `Community` is redundant with `Search` so remove `Community`
3. The  `Search` page should show up recent postings in reverse chronological order (most recent first by source event_date)
4. The `Post a new message` button should show up only after user has provided a serach first. We want to discourage user to post a message to start. We want to encourage user to search existing messages first.
5. Check and verify that When a user is authenticated, the actual user name or id should not show up in profile but instead it show the internal generated user-id. This is applicable regardless of identity provider authentication (like Google OAath). This  mimic the same functionality as in website `reddit.com` where user's identity is protected.
6. The landing page for both and mobile apps should be `search` where most recent postings already retrieved in search results. The existing landing page would go away or archived and not shown at this time. In case when there are significant number of recent postings, the use best practices to retrieve a handful and subsequent ones should be retrieved on scroll, as needed.

## website
1. The current landing page on website should go under a new page called `What We Do` with a link on landing page on top along with other links

## mobile
1. The `Community` button at bottom panel should be renamed to `Search`
2. Remove the search bar 'Ask the assistant` search bar for now. It will be re-introduced in future phase. Currently the focus is to search from ingested postings first. This will be consistent with website functionality.
3. The profile link on mobile is in two places on mobile app. Top right and bottom panel. Remove the icon on top right which navigates to `profile page.
4. Implement News Updates as specified in [GOV-NEWS-MOBILE-IMPLEMENTATION-PLAN.md](../../docs/ingestion/GOV-NEWS-MOBILE-IMPLEMENTATION-PLAN.md) 
5. The line 'Your Journey Starts Here` should be replaced by ''Your USA Immigration Journey Starts Here` on the flash screen (when app is opened)
