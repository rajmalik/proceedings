## Specifications for changes for phase-1a

## backend
The generic tag NAME `FAMILY-UNSPECIFIED`, change the tag name to `FAMILY-IMMIGRATION`

## search page on website and mobile both
1. Show tag `news-update` on search results page for all the results ingested as news
2. Show at least one relevant / main tag on the postings results page for each posting. If the tag `visa-applying-for` present is present then that must be shown along with posting description for each posting in the results page.
3. Consider a scenario: User provide a search string ("H1B RFE POE Boston") on main landing where search precision is set to `strict` and clicked search button. Following observations were made:
- I expected just one posting in results page as there was only posting which POE experrience from Boston. But the results many more postings which were not relevant to POE Boston experience. Since I had selected `strict` precision I expected to see results more closer to the search criteria posted. If the precision selected had been `Balanced` or `Broad`, then I would expect results which are not close match. So, please evaluate the search logic in backend to have a better experience for user. 
- I clicked on a posting to see details of that posting on that page.  I then click on `Back to Search` navigation link oon top left on posting details page and all my search criteria and its results are reset in search page.  I have to provide the criteria again and search again. I expected the search page to maintain the state after I come back to it
4. When a search criteria is entered , generate the tags for the search criteria (using the same tagging principles) and show  the tags for search criteria text (in separate section above `Refine Results`).  Allow user to alter the tags of search critera to refine the results based upon tags as well.
5. Do not show postings from news ingestion in search results page. Unless that news posting is less than 7 days old, based upon source event date. When a news ingestion posting is shown on search results, make sure it shows its tag `news-update` which must be present for that posting. 