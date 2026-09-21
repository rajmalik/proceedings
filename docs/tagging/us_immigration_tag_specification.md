# US Immigration & Visa Tagging System Specification

This document provides a standardized taxonomy for tagging content related to United States immigration and visas. It includes tag category, taxonomy, hierarchical categorization. 
ir includes cleanup rules, and an expanded list of tags.

## 1. Tag Categories
The cleaned up tag list consist of following tag categories:
### 1.1 Non-Immigration Visas 
This contains US Immigration Non-Immigration visas. Tags of this category will follow the naming convention UPPERCASE and may heve hyphen '-' in it. Examples:
`B-1`
`B-2`
`F-1`
`F-2`
`M-1`
`J-1`
`H-1`
`H-1B`
`H-1B1`
`H-2A`
`H-2B`
Refer to file [Non-Immigration Visas](../../backend/tags-cleaned/1.1-non-immigration-visas.csv) for the master tag list.


### 1.2 Immigration (Green Card) categories
This contains US Immigration Green Card categories. Tags of this category will follow the naming convention UPPERCASE and may heve hyphen '-' in it. Examples:
`EB-1`
`EB-1A`
`EB-1B`
`IR-1`

Refer to file [Green Card Categories](../../backend/tags-cleaned/1.2-greencard-categories.csv) for the master tag list.


### 1.3 Immigration related Abbreviations
This contains common abbreviations related to US Immigration. Tags of this category will follow the naming convention UPPERCASE and may heve hyphen '-' in it. Examples:
`NOIT`
`LCA`
`PWD`
`NOIT`
`TAL`
`PIMS`
`NOID`
`TN`
`EAD`
`CPT`

Refer to file [Abbreviations](../../backend/tags-cleaned/1.3-abbreviations.csv) for the master tag list.

### 1.4 Consulate codes along with City and Country codes
This contains the code related to US Embassy/Consulates all around the worlsd. Naming convention of tags in this category is UPPERCASE. The tag can be a specific code given to a consulate or a city that consulate is located or even broadly in the COuntry where conslate is in.  For example if following is list of consulates in Australia:

| Country   | Country Code | City      | City Code | Post Code |
|:----------|:-------------|:----------|:----------|:----------|
| Australia | `AU`         | Canberra  | `CBR`     | `CAN`     |
| Australia | `AU`         | Melbourne | `MEL`     | `MEL`     |
| Australia | `AU`         | Perth     | `PER`     | `PER`     |
| Australia | `AU`         | Sydney    | `SYD`     | `SYD`     |

Then the valid tags for Australia can be a or `City Code` or `Country Code`. `Post Code`  can be ignored. So, the valid tags in this case are:
`AU`
`CBR`
`MEL`
`PER`
`SYD`

Refer to file [Consulates](../../backend/tags-cleaned/1.4-consulates.csv) for the master tag list.

### 1.5 Immigration related Forms as specified by United States Government agencies like USCIS and/or US State Department
This contains all immigration/ non-immigration forms. Any legal forms related to the processing etc. Naming convention of tags in this category is UPPERCASE and can contain hyphen `-` in it. While the comprehensive list of these forms is not provided. Please lookup US given agencies (USCIS/ State Govt etc.) for a list of such forms. Some example are provided below:
`I-751`
`I-140`
`I-129`
`I-526`
`I-9`
`I-485`
`I-765`
`I-131`
`I-90`
`I-539`
`DS-160`

Refer to file [Forms](../../backend/tags-cleaned/1.5-forms.csv) for the master tag list.


### 1.6 Tags in the category of an action or an attribute associated with a form or a visa. 

Any action or attrubute related to a form or visa. For Example

| Tag             | Associated with form or Visa |
|:----------------|:-----------------------------|
| `h1b-transfer`  | `H-1B`                       |
| `h1b-petition`  | `H-1B`                       |
| `i212-waiver` | `I-212`                      |

Refer to file [Visa/Form Actions](../../backend/tags-cleaned/1.6-visa-form-actions.csv) for the master tag list.

The naming convention rules to follow in this cateegory is as follows:
- **visa-action format** or **formname-action format**
- Form name or Visa name is converted to lowercase and all hyphen '-' removed from its name. So `H-1B` becomes 'h1b' and form `I-212` becomes `i212`
- The action associated is converted to lowercase and normalized. For example `filing` `file` `filed` `Filed` becomes `filed` 
- DO not create duplicate tags like `h1-transfer` and `h1b-transfer`. All `H-1` visa category are considered as `H-1B` unless otherwise specified.
- The comprehensive list of all actions associated with every visa or form is not provided. Please lookup official US given agencies (USCIS/ State Govt etc.) to create this list. Some examples

### 1.7 Key Stages in processing of an application or key information where we need key-value pair
This contains tags which are stages in processing of an application or form. This category of tags when used in a content will be in the form of key value pair where this category will be the key in key-value pair. This tag can be any of following:
- A form name as it is, as described in section 1.5 above
- A non-immigration visa as described in section 1.1 above
- An abbreviation, as described in section 1.3 above
- An action related or an attribute associated with a form or a visa, as described in sectjon 1.6 above

The only difference for this category is the usage of these tags (when the tags are used to tag a content), this category will use the tag in key-value pair, where this category will be used as key.
- The tags in this category can keep the original naming convention of the tag (as the tag is same but used in key-value pair). 
- There are some tags (listed below) which do not come from above categories but is used only here in key-value pair. The  naming convention of the tags where it does not come from above categories is where we use underscores `_` instead of hyphens `-` . 
- Some examples of such tags:
`outcome_status`
`spouse_status`
`ceac_status_issued`
`ceac_status`
`ceac_status_approved`
`ceac_status_issued`

Refer to file [Key Stages](../../backend/tags-cleaned/1.7-key-stages.csv) for the master tag list.

### 1.8 Key Dates attributes names in processing of an application or key information where the information needs to be stored as dates
When we want to tag or label content and the information is a date (stored as a value in key-value pair) then the attribute name that key belong to this category.

The naming convention rules format to follow in this cateegory is as follows:
- **visa_action_date** or **formname_action_date**
- Form name or Visa name is converted to lowercase and all hyphen '-' removed from its name. So `H-1B` becomes 'h1b' and form `I-212` becomes `i212`
- The action associated is converted to lowercase and normalized. For example `filing` `file` `filed` `Filed` becomes `filed` 
- The tag ends with `_date` for any attributes which would have a date as value when the content is tagged with this attribute
- DO not create duplicate tags and normalize the action part of attribute name as done in section 1.6 above
- The comprehensive list of all dates associated with every visa or form is not provided. Please lookup official US given agencies (USCIS/ State Govt etc.) to create this list. Some examples
- Some examples of the tags of this category are:
`60day_grace_period_expire_date`
`240days_expiration_date`
`aos_appointment_date`
`aos_approved_date`
`biometrics_appointment_date`
`date_of_admission`
`employment_end_date`
`f1_expire_date`
`h1b_receipt_date`
`i130_file_date`
`i131_file_date`
`i485_file_date`
`i765_file_date`
`i94_expire_date`
`layoff_notification date`
`opt_expire_date`
`priority_date`
`visa_expire_date`
`visa_interview_date`
`i129_file_date`
`h1b_processing_start_date`
`rfe_date`

Refer to file [Key Dates](../../backend/tags-cleaned/1.8-key-dates.csv) for the master tag list.

### 1.9 Key outcomes as a result of a processing of an application
The tags in the category are the outcomes of a processing of application. The usage of these tags in actual labelling of content will be in a key-value pair where this tag will be a value in key-value pair. Some examples of the tags of this category are:
`approved`
`refused`
`rejected`
`issued`
`RFE`
`pending`
`expired`
`valid`
`invalid`
`not-filed-yet`

The naming convention of the tags of thie category are that it needs to lowercase and use hyphen `-`, if required as shown in example above.

Refer to file [Outcomes](../../backend/tags-cleaned/1.9-outcomes.csv) for the master tag list.

### 1.10 Common or miscelanneaous terms, issues, concerns associated with processing of applications. 
-These contain common layman terms as reported by candidates
- These terms can have an equivalent legal term and/or may have other synonyms which are used as different tag name.
For example:
`h1-petition` `h1b-petition` `i129-filing` may mean the same thing in legal terms but user any of these terms
Therefore the tags in this category can be redundant with the tags on other category
- The knowledge base where the tags can be redundant will come into play when the content is searched symantically based opon labelling or tagging of content
- The naming convention of the tags of this category is **Kebab-case:** The tags should be lowercase and hyphenated (e.g., `employment-based-immigration`) 
Some examples of tags of this category are:
l`lawyer-recommendation`
`100k-fee`
`wage-level-compliance`
`60day-grace-period`
`bench-policy`
`speciality-occupation`
`h1b-material-change`
`fdns-visit`
`h1b-6-year-rule`
`stamping-delay`
`h4-work-auth`
`aging-out`
`third-country`
`prior-visa-rejection`
`first-time-visa`
`visa-stamping`

Refer to file [Common / Misc](../../backend/tags-cleaned/1.10-common-misc.csv) for the master tag list.

## 2. Tag List Principles

### 2.1 * **Hierarchical Structure:** 
Tags contain Hierarchical Structure, meaning it can have Parent and CHild tags like following example:

Examples: 

| Tag    | Parent Tag             |
|:-------|:-----------------------|
| `H-1`  | `temporary-work-visas` |
| `H-1B` | `H-1`                  |
| `h1b-extension` | `H-1B`                 |
| `j1-renewal` | `J-1`                  |

### 2.2 * **Exclusivity:**
 Avoid overlapping tags where possible. Examples: 
- if `h1b` is used, the system should automatically understand it falls under `non-immigrant-work-visas`
- if `h1` is used, then by default it refers to `h1b`


### 2.3. Naming Convention
- Depending upon the tag category (as described in section 1 above), each category's naming convention is defined in corresponding category in section 1.


## 2.3 Hierarchical Structure and Constraints
Tags can have a `Parent > Child` relationship to allow for broad and granular filtering. 

| Parent Tag                     | Child Tag       |
|:-------------------------------|:----------------|
| `employment-based-immigration` | `EB-1`          |
| `EB-1`                         | `EB-1A`         |
| `EB-1`                         | `EB-1B`         |
| `family-based-immigration`     | `IR-1`          |
| `temporary-work-visa`          | `O-1`           |
| `temporary-work-visa`          | `H-1B`          |
| `H-1B`                         | `h1b-lottery`   |
| `H-1B`                         | `h1b-extension` |

* **Rules to apply:**
- Tags follow Parent > Child relationships 
- Example: `employment-based-immigration` > `EB-1` > `EB-1A`
- tag list is a flat structure 
- Each Parent and Child are separate tags and no tag relations are maintained in the tag list


## 3. Taxonomy and Normalization Rules

* **Rules to apply:**

1) Duplicate concepts and tags can be and should be consolidated.  Some visas and tag names are synonyms and are used interchangeably, which should be consolidated as much as possible

| potential tag                | actual tag to keep |
|:-----------------------------|:-------------------|
| `PR`                         | `green-card`       |
| `permanent-residency`        | `green-card`       |
| `eb1`                        | `EB-1`             |
| `h1b`                        | `H-1B`             |
| `h1-extension`               | `h1b-extension`    |
| `h1`                         | `H-1B`             |
| `naturalization-citizenship` | `naturalization`   |


Some tags normalize to same tag, For example:
- Forms without hyphens normalize to hyphenated versions: `i797` → `I-797`
- `H-1`, `H1`, `h1`, `h1b` all normalize to `H-1B`
`H-1` or similar names like following are always normalized to `H-1B` unless otherwise stated specifically 

| potential tag | actual tag to keep |
|:--------------|:-------------------|
| `h1b`         | `H-1B`             |
| `h1`          | `H-1B`             |
| `H1`          | `H-1B`             |
| `H-1`         | `H-1B`             |


2)  Child tags for `H-1B` visa category use `h1b-` prefix, not `h1-` assume all `h1` unless otherwise specified defaults to `h1b`

| potential tag         | actual tag to keep |
|:----------------------|:-------------------|
| `h1-extension`        | `h1b-extension`    |
| `h1-withdrawal`       | `h1b-withdrawal`   |
| `H1-portability-rule` | `h1b-portability-rule`   |

4) All visas and forms names (which do not have actions in the name) whould be in uppercase with  `-` in name. For example:

| potential tag       | actual tag to keep   |
|:--------------------|:---------------------|
| `i797`              | `I-797`              |
| `I797a`             | `I-797A`             |

5) visas and forms names (which do have actions in the name) should be Kebab-case. That is, The tags it should lowercase and hyphenated and `-` removed in visa name or form name.

| potential tag       | actual tag to keep |
|:--------------------|:-------------------|
| `H-1B-Extension` | `h1b-extension`    |
| `DS-160-question` | `ds160-question`   |

6) There should not be any redundancy with actions of same visa or form. For example:

| potential tag | actual tag to keep |
|:--------------|:-------------------|
| `h1-renew`    | `h1b-renewal`      |
| `h1-renewal`  | `h1b-renewal`      |
| `h1b-renewal` | `h1b-renewal`      |

7) There should not be redundancy in the name itself for visa and form-names itself as name should not have a description within the tag itself

| potential tag          | actual tag to keep |
|:-----------------------|:-------------------|
| `f1-student-visa`      | `F-1`              |
| `eb-2-advanced-degree` | `EB-2`             |
| `b2-visitor-visa`      | `B-2`              |
| `o1-extraordinary-ability`      | `O-1`              |
| `ead-employment-authorization`      | `EAD`              |
| `h1b-specialty-occupation`     | `H-1B`             |
| `advance-parole-travel`      | `advance-parole`   |


8) Do not combine different tags together in same tag. Split them into different tags. For example:

| potential tag           | actual tags to keep         |
|:------------------------|:----------------------------|
| `eb-2-niw`              | `EB-2`     `NIW`            |
| `h1-premium-processing` | `H-1B` `premium-processing` |
| `b2-visitor-visa`       | `B-2`                       |

9) * **tag with abbreviation** Following tags were originally listed as exceptions
   to the above rules, intended to coexist alongside their abbreviation.
   **Updated (see `features/timeline-notifications-3/timeline-notifications-{ead,485,coe}.md`
   for the full live-tagging-evidence writeups):** live Gemini extraction
   testing found each pair behaves differently in practice, not uniformly —
   so "keep both, always" no longer holds. Each row below now states which
   form actually survived as the canonical, currently-selectable tag:

| tag name                       | corresponding abbreviation | Description                                        | Current state |
|:-------------------------------|:---------------------------|:---------------------------------------------------|:---------------|
| `change-of-employer-COE`       | ~~COE~~ (retired)          | Process of changing employer on a work visa        | Only the tag name survives — `COE` was never selected by the model even when the query text used the literal acronym; retired from `1.3-abbreviations.csv`. |
| ~~`adjustment-of-status-AOS`~~ (retired) | AOS               | Process of Change of Status from one visa to other | Only the abbreviation survives — the opposite direction from COE; retired from `1.10-common-misc.csv`, `_AOS_TAGS` updated accordingly. |
| `employment-authorization-EAD` | EAD                        | Process to get authorized to work legally          | Never actually existed as a separate `1.10` duplicate in `tags-cleaned/` — only `EAD` (1.3) is real; this row was aspirational even before this update. |

10) * **Redundancy Exceptions ** There may be some edge-cases where tags can symmentically refer to same tag of different category but with different name. FOr example:

`h1b-petition` `i129-filing` may mean the same thing in legal terms but have different names belonging to different tag category as specified in section 1. We may have redundancy of these kind of tags but in the uase case of symmentic search when the content is tagged with different name (as in this case) we may have to perform a step so that similar content can be returned in search results even if the tag names are different but symmentically it means the same.

Therefore, we may have tags that can be redundant which are named differently.

