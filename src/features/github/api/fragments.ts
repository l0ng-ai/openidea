/**
 * GraphQL fragments of IntelliJ's GitHub plugin (`resources/graphql/fragment`, plus
 * collaboration-tools' `pageInfo`), verbatim. Each one is named after its file, the
 * name it is spread with (`...name`); `withFragments` adds the ones a document needs.
 */
export const FRAGMENTS: Readonly<Record<string, string>> = {
  actor: `
  fragment actor on Actor {
    ...actorInfo

    ... on User {
      ...userInfo
    }
    ... on EnterpriseUserAccount {
      ...enterpriseUserAccountInfo
    }
    ... on Organization {
      ...organizationInfo
    }
  }
`,
  actorInfo: `
  # Just the data that should be present for any type of Actor.
  fragment actorInfo on Actor {
    __typename
    ...nodeInfo
    login
    url
    avatarUrl
  }
`,
  checkRun: `
  fragment checkRun on CheckRun {
    name
    conclusion
    isRequired(pullRequestNumber: $number) # See: findPullRequestMergeability
    detailsUrl
    url
  }
`,
  checkSuite: `
  fragment checkSuite on CheckSuite {
    checkRuns(first: 100) {
      pageInfo {
        ...pageInfo
      }
      nodes {
        ...checkRun
      }
    }
  }
`,
  comment: `
  fragment comment on Comment {
    ...nodeInfo
    author {
      ...actor
    }
    body
    createdAt
    ...reactions
  }
`,
  commit: `
  fragment commit on Commit {
      ...commitShort
      committer {
          ...gitActorInfo
      }
      messageBody
      committedDate
      parents(first: 100) {
          nodes {
              ...commitHash
          }
      }
  }
`,
  commitHash: `
  fragment commitHash on Commit {
      ...nodeInfo
      oid
      abbreviatedOid
  }
`,
  commitShort: `
  fragment commitShort on Commit {
      ...commitHash
      url
      messageHeadline
      author {
          ...gitActorInfo
      }
  }
`,
  commitStatusContext: `
  fragment commitStatusContext on StatusContext {
    context
    state
    isRequired(pullRequestNumber: $number) # See: findPullRequestMergeability
    targetUrl
  }
`,
  commitStatusRollup: `
  fragment commitStatusRollup on StatusCheckRollup {
    contexts(first: $pageSize, after: $cursor) {
      pageInfo {
        ...pageInfo
      }
      nodes {
        __typename
        ... on CheckRun {
          checkSuite {
            workflowRun {
              workflow {
                name
              }
            }
          }
          name
          title
          status
          conclusion
          url
        }
        ... on StatusContext {
          context
          description
          state
          targetUrl
        }
      }
    }
  }
`,
  commitStatusRollupShort: `
  fragment commitStatusRollupShort on StatusCheckRollup {
    state
  }
`,
  commitWithCheckStatuses: `
  fragment commitWithCheckStatuses on Commit {
    ...commitHash
    status {
      contexts {
        ...commitStatusContext
      }
    }

    checkSuites(first: 100) {
      pageInfo {
        ...pageInfo
      }
      nodes {
        ...checkSuite
      }
    }
  }
`,
  enterpriseUserAccountInfo: `
  fragment enterpriseUserAccountInfo on EnterpriseUserAccount {
    name
  }
`,
  gitActorInfo: `
  fragment gitActorInfo on GitActor {
    name
    email
    avatarUrl
    date
    user {
      ...user
    }
  }
`,
  gitRefName: `
  fragment gitRefName on Ref {
    name
  }
`,
  labelInfo: `
  fragment labelInfo on Label {
    ...nodeInfo
    url
    name
    color
  }
`,
  nodeInfo: `
  fragment nodeInfo on Node {
    id
  }
`,
  organizationInfo: `
  fragment organizationInfo on Organization {
    name
  }
`,
  pageInfo: `
  fragment pageInfo on PageInfo {
      startCursor
      hasPreviousPage
      endCursor
      hasNextPage
  }
`,
  pullRequestBranchMatch: `
  fragment pullRequestBranchMatch on PullRequest {
    ...nodeInfo
    number
    title
    headRefName
  }
`,
  pullRequestCommitWithCheckStatuses: `
  fragment pullRequestCommitWithCheckStatuses on PullRequestCommit {
    ...nodeInfo
    commit {
      ...commitWithCheckStatuses
    }
  }
`,
  pullRequestInfo: `
  fragment pullRequestInfo on PullRequest {
    ...pullRequestInfoShort

    body

    author {
      ...actor
    }
    createdAt

    reviewDecision

    baseRefName
    baseRefOid
    baseRepository {
      ...repository
    }

    headRef {
      id
    }
    headRefName
    headRefOid
    headRepository {
      ...repository
    }

    viewerCanDeleteHeadRef
  }
`,
  pullRequestInfoShort: `
  fragment pullRequestInfoShort on PullRequest {
    ...nodeInfo
    url
    number

    title
    state
    isDraft

    author {
      ...actor
    }
    createdAt
    updatedAt

    isReadByViewer

    assignees(first: 100) {
      nodes {
        ...user
      }
    }
    labels(first: 100) {
      nodes {
        ...labelInfo
      }
    }
    reviewRequests(first: 100) {
      nodes {
        ... on ReviewRequest {
          requestedReviewer {
            ...pullRequestReviewer
          }
        }
      }
    }
    reviewThreads(last: 100) {
      nodes {
        isResolved
        isOutdated
      }
    }
    reviews(last: 100) {
      nodes {
        ...pullRequestReview
      }
    }
    ...reactions

    mergeable

    viewerCanUpdate
    viewerCanReact
    viewerDidAuthor
  }
`,
  pullRequestMergeability: `
  fragment pullRequestMergeability on PullRequest {
    mergeable
    canBeRebased
    mergeStateStatus
    baseRef {
      refUpdateRule {
        ...refUpdateRule
      }
    }

    commits(last: 1) {
      pageInfo {
        ...pageInfo
      }
      nodes {
        ...pullRequestCommitWithCheckStatuses
      }
    }
  }
`,
  pullRequestPendingReview: `
  fragment pullRequestPendingReview on PullRequestReview {
    ...nodeInfo
    state
    comments(first: 0) {
      totalCount
    }
  }
`,
  pullRequestReview: `
  fragment pullRequestReview on PullRequestReview {
    __typename
    ...nodeInfo
    url
    author {
      ...actor
    }
    body
    state
    createdAt
    viewerCanUpdate
  }
`,
  pullRequestReviewComment: `
  fragment pullRequestReviewComment on PullRequestReviewComment {
    ...comment
    url
    state
    commit {
      ...commitHash
    }
    originalCommit {
      ...commitHash
    }
    diffHunk
    pullRequestReview {
      ...nodeInfo
    }
    viewerCanDelete
    viewerCanUpdate
    viewerCanReact
  }
`,
  pullRequestReviewer: `
  fragment pullRequestReviewer on RequestedReviewer {
    ... on Actor {
      ...actorInfo
    }
    ... on User {
      ...userInfo
    }
    ... on Team {
      ...teamInfo
    }

    # For future enthusiasts: be careful with adding ... on Bot, as it's been added only in GHE 3.11
  }
`,
  pullRequestReviewThread: `
  fragment pullRequestReviewThread on PullRequestReviewThread {
    ...nodeInfo
    isResolved
    isOutdated
    path
    subjectType
    diffSide
    line
    originalLine
    startDiffSide
    startLine
    originalStartLine
    comments(first: 100) {
      nodes {
        ...pullRequestReviewComment
      }
    }
    viewerCanReply
    viewerCanResolve
    viewerCanUnresolve
  }
`,
  pullRequestTemplate: `
  fragment pullRequestTemplate on PullRequestTemplate {
    body
  }
`,
  rates: `
  fragment rates on RateLimit {
    cost
  }
`,
  reaction: `
  fragment reaction on Reaction {
    content
    user {
      ...user
    }
  }
`,
  reactions: `
  fragment reactions on Reactable {
    reactions(first: 25) {
      pageInfo {
        ...pageInfo
      }
      nodes {
        ...reaction
      }
    }
  }
`,
  refUpdateRule: `
  fragment refUpdateRule on RefUpdateRule {
    allowsDeletions
    allowsForcePushes
    pattern
    requiredApprovingReviewCount
    requiredStatusCheckContexts
    requiresLinearHistory
    requiresSignatures
    viewerCanPush
  }
`,
  repository: `
  fragment repository on Repository {
    ...nodeInfo
    owner {
      ...repositoryOwnerName
    }
    nameWithOwner
    viewerPermission

    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed

    defaultBranchRef {
      ...gitRefName
    }
    isFork
    url
    sshUrl
  }
`,
  repositoryOwnerName: `
  fragment repositoryOwnerName on RepositoryOwner {
      __typename
      ...nodeInfo
      login
  }
`,
  teamInfo: `
  fragment teamInfo on Team {
      __typename
      ...nodeInfo
      slug
      url
      teamAvatarUrl: avatarUrl
      teamName: name
      combinedSlug
  }
`,
  user: `
  fragment user on User {
    ...actorInfo
    ...userInfo
  }
`,
  userInfo: `
  fragment userInfo on User {
    name
  }
`,
};
