## Advanced Seeach Capability

## Overview
Currently user can enter text in Home page and search postings. We want to provide user more advanced capabilities to provide answer to user by introducing `Advanced Seach` button next to Search button.

## Task
1. Implement "Advanced Search" Functionality as per secifications below
2. Interface/functionality of "Advanced Search" page will be similar to the interface/functionality  of "Find / Create Groups" functionality in page [Find Groups](https://meridianjourney.ai/find) Except that it will return postings instead of users based upon tags
3. This implementation apply to both website and mobile platform.

## Preface
1. The headers / category of tags referred in below section refer to tag headers. For example:
- "Current Status" referred by tag "current_visa_or_greencard_category" in backend
- "Visa Applying for" referred by tag "visa_applying_for" in backend
- "Consulate" referred by "consulates" tag in backend

## Specifications of `Advanced Search` page
1. Page will look similar to page on [Find Groups](https://meridianjourney.ai/find)
2. There will be a big text box panel in UI on left and generated tags panel on right
3. Do not show all the headers / category of tags on initial page load in the Advanced Search page as is being shown on "Find Groups" page
4. Same functionality of user entering text on left panel and clicks on "Send" button will generate tags which will be shown on right panel. 
5. Show only relevant headers / category of tags on right based on search criteria entered and tags generated
6. On the tag selection box on right panel, allow user to enter text which will fetch relevant tags based upon the text entered and allos user to select valid tag
7. Only valid tags must be allowed on right panel
8. User will have the ability to add/remove tags in right panel as on [Find Groups](https://meridianjourney.ai/find)
9. User will click on the button on right panel which will say "Search" instead of "Find matches"
10. Backend will search results using existing search mechanism as before using the tags and the text entered by user
11. Same results page as current one will appear with results 
12. User will the ability to go back to "Advanced Search" page where the state is maintained in UI with previous text/selections

