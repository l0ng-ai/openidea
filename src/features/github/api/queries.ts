/**
 * GraphQL documents of IntelliJ's GitHub plugin (`resources/graphql/query`), verbatim and
 * named after their files. They spread fragments from `fragments.ts`, which
 * `withFragments` (in `document.ts`) appends before a document is sent.
 */

export const addPullRequestReviewThread = `
mutation ($body: String!, $line: Int!, $path: String!, $pullRequestReviewId: ID, $side: DiffSide, $startSide: DiffSide, $startLine: Int) {
  addPullRequestReviewThread(input: {body: $body, line: $line, path: $path, pullRequestReviewId:$pullRequestReviewId, side: $side, startSide: $startSide, startLine: $startLine}) {
    thread {
      ...pullRequestReviewThread
    }
  }
}
`;

export const addReaction = `
mutation ($id: ID!, $reaction: ReactionContent!) {
  addReaction(input: {
    subjectId: $id,
    content: $reaction
  }) {
    reaction {
      ...reaction
    }
  }
}
`;

export const addReviewComment = `
mutation ($reviewId: ID!, $body: String!, $commit: GitObjectID, $file: String, $position: Int, $inReplyTo: ID) {
  addPullRequestReviewComment(input: {pullRequestReviewId: $reviewId, body: $body, commitOID: $commit, path: $file, position: $position, inReplyTo: $inReplyTo}) {
    comment {
      ...pullRequestReviewComment
    }
  }
}
`;

export const createPullRequest = `
mutation ($repositoryId: ID!, $baseRefName: String!, $headRefName: String!, $title: String!, $body: String, $draft: Boolean = false) {
  createPullRequest(input: {
    repositoryId: $repositoryId,
    baseRefName: $baseRefName,
    headRefName: $headRefName,
    title: $title,
    body: $body,
    draft: $draft
  }) {
    pullRequest {
      ...pullRequestInfoShort
    }
  }
}
`;

export const createReview = `
mutation ($pullRequestId: ID!, $event: PullRequestReviewEvent, $body: String, $commitOid: GitObjectID, $threads: [DraftPullRequestReviewThread]) {
  addPullRequestReview(input: {pullRequestId: $pullRequestId, event: $event, body: $body, commitOID: $commitOid, threads: $threads}) {
    pullRequestReview {
      ...pullRequestPendingReview
    }
  }
}
`;

export const deleteIssueComment = `
mutation ($id: ID!) {
    deleteIssueComment(input: {id: $id}) {
        __typename
    }
}
`;

export const deleteRef = `
mutation ($refId: ID!) {
  deleteRef(input: {refId: $refId}) {
    clientMutationId
  }
}
`;

export const deleteReview = `
mutation ($reviewId: ID!){
    deletePullRequestReview(input: {pullRequestReviewId: $reviewId}) {
        __typename
    }
}
`;

export const deleteReviewComment = `
mutation ($id: ID!) {
    deletePullRequestReviewComment(input: {id: $id}) {
        pullRequestReview {
            ...pullRequestPendingReview
        }
    }
}
`;

export const findMentionableUsers = `
query($repoOwner: String!, $repoName: String!, $pageSize: Int = 100, $cursor: String) {
  repository(owner: $repoOwner, name: $repoName) {
    mentionableUsers(first: $pageSize, after: $cursor) {
      pageInfo {
        ...pageInfo
      }
      nodes {
        ...user
      }
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const findOrganizationTeams = `
query($organization: String!, $pageSize: Int = 100, $cursor: String) {
  organization(login: $organization) {
    teams(first: $pageSize, after: $cursor) {
      pageInfo {
        ...pageInfo
      }
      nodes {
        ...teamInfo
      }
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const findPendingReview = `
query($pullRequestId: ID!) {
  node(id: $pullRequestId) {
    ... on PullRequest {
      reviews(states: [PENDING], first: 1) {
        nodes {
          ...pullRequestPendingReview
        }
      }
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const findPullRequest = `
query($repoOwner: String!, $repoName: String!, $number: Int!) {
  repository(owner: $repoOwner, name: $repoName) {
    pullRequest(number: $number) {
      ...pullRequestInfo
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const findPullRequestId = `
query($repoOwner: String!, $repoName: String!, $number: Int!) {
  repository(owner: $repoOwner, name: $repoName) {
    pullRequest(number: $number) {
      ...nodeInfo
      number
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const findPullRequestMergeability = `
query($repoOwner: String!, $repoName: String!, $number: Int!) {
  repository(owner: $repoOwner, name: $repoName) {
    pullRequest(number: $number) {
      ...pullRequestMergeability
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const findPullRequestsByHeadBranch = `
query findPullRequestsByHeadBranch($query: String!, $pageSize: Int = 100, $cursor: String) {
  search(first: $pageSize, after: $cursor, type: ISSUE_ADVANCED, query: $query) {
    pageInfo {
      ...pageInfo
    }
    nodes {
      ...pullRequestBranchMatch
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const findRepository = `
query($repoOwner: String!, $repoName: String!) {
  repository(owner: $repoOwner, name: $repoName) {
    ...repository
  }

  rateLimit {
    ...rates
  }
}
`;

export const findUser = `
query($login: String!) {
  user(login: $login) {
    __typename
    ...user
  }

  rateLimit {
    ...rates
  }
}
`;

export const getProtectionRules = `
query($repoOwner: String!, $repoName: String!, $pageSize: Int = 100, $cursor: String) {
  repository(owner: $repoOwner, name: $repoName) {
    branchProtectionRules(first: $pageSize, after: $cursor) {
      pageInfo {
        ...pageInfo
      }
      nodes {
        ...nodeInfo
        pattern
      }
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const getPullRequestTemplates = `
query($repoOwner: String!, $repoName: String!) {
  repository(owner: $repoOwner, name: $repoName) {
    pullRequestTemplates {
      ...pullRequestTemplate
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const getRepositoryCommitStatusContexts = `
query($repoOwner: String!, $repoName: String!, $oid: GitObjectID!, $pageSize: Int, $cursor: String) {
  repository(owner: $repoOwner, name: $repoName) {
    object(oid: $oid) {
      ... on Commit {
        statusCheckRollup {
          ...commitStatusRollup
        }
      }
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const getRepositoryCommitStatusShort = `
query($repoOwner: String!, $repoName: String!, $oid: GitObjectID!) {
  repository(owner: $repoOwner, name: $repoName) {
    object(oid: $oid) {
      ... on Commit {
        statusCheckRollup {
          ...commitStatusRollupShort
        }
      }
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const issueSearch = `
query issueSearch($query: String!, $pageSize: Int = 100, $cursor: String) {
  search(first: $pageSize, after: $cursor, type: ISSUE, query: $query) {
    pageInfo {
      ...pageInfo
    }
    nodes {
      ...pullRequestInfoShort
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const markFileAsViewed = `
mutation ($pullRequestId: ID!, $path: String!) {
    markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) {
        __typename
    }
}
`;

export const markPullRequestReadyForReview = `
mutation ($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) {
        __typename
    }
}
`;

export const metrics = `
query metrics(
  $allPRCountQuery: String!,
  $openPRCountQuery: String!,
  $openAuthoredPRCountQuery: String!,
  $openAssigneePRCountQuery: String!,
  $openReviewedPRCountQuery: String!,
  $openReviewAssignedPRCountQuery: String!,
) {
  allPRCount: search(type: ISSUE, query: $allPRCountQuery) {
    issueCount
  }

  openPRCount: search(type: ISSUE, query: $openPRCountQuery) {
    issueCount
  }

  openAuthoredPRCount: search(type: ISSUE, query: $openAuthoredPRCountQuery) {
    issueCount
  }

  openAssigneePRCount: search(type: ISSUE, query: $openAssigneePRCountQuery) {
    issueCount
  }

  openReviewedPRCount: search(type: ISSUE, query: $openReviewedPRCountQuery) {
    issueCount
  }

  openReviewAssignedPRCount: search(type: ISSUE, query: $openReviewAssignedPRCountQuery) {
    issueCount
  }

  rateLimit {
    ...rates
  }
}
`;

export const pullRequestCommits = `
query($repoOwner: String!, $repoName: String!, $number: Int!, $pageSize: Int = 100, $cursor: String) {
  repository(owner: $repoOwner, name: $repoName) {
    pullRequest(number: $number) {
      commits(first: $pageSize, after: $cursor) {
        pageInfo {
          ...pageInfo
        }
        nodes {
          ...nodeInfo
          commit {
            ...commit
          }
          url
        }
      }
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const pullRequestFiles = `
query($repoOwner: String!, $repoName: String!, $number: Int!, $pageSize: Int = 100, $cursor: String) {
  repository(owner: $repoOwner, name: $repoName) {
    pullRequest(number: $number) {
      files(first: $pageSize, after: $cursor) {
        pageInfo {
          ...pageInfo
        }
        nodes {
          path
          viewerViewedState
        }
      }
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const pullRequestParticipants = `
query($repoOwner: String!, $repoName: String!, $number: Int!, $pageSize: Int = 100, $cursor: String) {
  repository(owner: $repoOwner, name: $repoName) {
    pullRequest(number: $number) {
      participants(first: $pageSize, after: $cursor) {
        pageInfo {
          ...pageInfo
        }
        nodes {
          ...user
        }
      }
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const pullRequestReviewThreads = `
query($repoOwner: String!, $repoName: String!, $number: Int!, $pageSize: Int = 100, $cursor: String) {
  repository(owner: $repoOwner, name: $repoName) {
    pullRequest(number: $number) {
      reviewThreads(first: $pageSize, after: $cursor) {
        pageInfo {
          ...pageInfo
        }
        nodes {
          ...pullRequestReviewThread
        }
      }
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const pullRequestTimeline = `
fragment issueCommentInfo on IssueComment {
  ...comment
  viewerCanUpdate
  viewerCanDelete
  viewerCanReact
}

fragment prCommitInfo on PullRequestCommit {
  ...nodeInfo
  commit {
    ...commitShort
  }
  url
}

fragment reviewDismissedEvent on ReviewDismissedEvent {
  actor {
    ...actor
  }
  createdAt
  dismissalMessageHTML
  review {
    author {
      ...actor
    }
  }
}

fragment readyForReviewEvent on ReadyForReviewEvent {
  actor {
    ...actor
  }
  createdAt
}

fragment convertToDraftEvent on ConvertToDraftEvent {
  actor {
    ...actor
  }
  createdAt
}

fragment renamedEvent on RenamedTitleEvent {
  actor {
    ...actor
  }
  previousTitle
  currentTitle
  createdAt
}

fragment closedEvent on ClosedEvent {
  actor {
    ...actor
  }
  createdAt
}

fragment reopenedEvent on ReopenedEvent {
  actor {
    ...actor
  }
  createdAt
}

fragment mergedEvent on MergedEvent {
  actor {
    ...actor
  }
  createdAt
  mergedEventCommit: commit {
    ...commitShort
  }
  mergeRefName
}

fragment assignedEvent on AssignedEvent {
  actor {
    ...actor
  }
  createdAt
  user {
    ...user
  }
}

fragment unassignedEvent on UnassignedEvent {
  actor {
    ...actor
  }
  createdAt
  user {
    ...user
  }
}

fragment labeledEvent on LabeledEvent {
  actor {
    ...actor
  }
  createdAt
  label {
    ...labelInfo
  }
}

fragment unlabeledEvent on UnlabeledEvent {
  actor {
    ...actor
  }
  createdAt
  label {
    ...labelInfo
  }
}

fragment reviewRequestedEvent on ReviewRequestedEvent {
  actor {
    ...actor
  }
  createdAt
  requestedReviewer {
    ...pullRequestReviewer
  }
}

fragment reviewRequestRemovedEvent on ReviewRequestRemovedEvent {
  actor {
    ...actor
  }
  createdAt
  requestedReviewer {
    ...pullRequestReviewer
  }
}

fragment gitRefName on Ref {
  name
}

fragment baseRefForcePushedEvent on BaseRefForcePushedEvent {
  actor {
    ...actor
  }
  createdAt
  ref {
    ...gitRefName
  }
}

fragment headRefForcePushedEvent on HeadRefForcePushedEvent {
  actor {
    ...actor
  }
  createdAt
  ref {
    ...gitRefName
  }
  beforeCommit {
    ...commitHash
  }
  afterCommit {
    ...commitHash
  }
}

fragment headRefDeletedEvent on HeadRefDeletedEvent {
  actor {
    ...actor
  }
  createdAt
  headRefName
}

fragment headRefRestoredEvent on HeadRefRestoredEvent {
  actor {
    ...actor
  }
  createdAt
}

fragment baseRefChangedEvent on BaseRefChangedEvent {
  actor {
    ...actor
  }
  createdAt
}

fragment referenceSubject on ReferencedSubject {
  __typename
  ... on PullRequest {
    title
    number
    prState: state
    isDraft
    url
  }
  ... on Issue {
    title
    number
    issueState: state
    url
  }
}

fragment crossReferencedEvent on CrossReferencedEvent {
  actor {
    ...actor
  }
  createdAt
  source {
    ...referenceSubject
  }
}

fragment connectedEvent on ConnectedEvent {
  actor {
    ...actor
  }
  createdAt
  subject {
    ...referenceSubject
  }
}

fragment disconnectedEvent on DisconnectedEvent {
  actor {
    ...actor
  }
  createdAt
  subject {
    ...referenceSubject
  }
}

query($repoOwner: String!, $repoName: String!, $number: Int!, $pageSize: Int = 100, $cursor: String, $since: DateTime) {
  repository(owner: $repoOwner, name: $repoName) {
    pullRequest(number: $number) {
      timelineItems(first: $pageSize, after: $cursor, since: $since) {
        pageInfo {
          ...pageInfo
        }
        nodes {
          __typename
          ...prCommitInfo
          ...pullRequestReview
          ...issueCommentInfo

          ...renamedEvent

          ...closedEvent
          ...reopenedEvent
          ...mergedEvent

          ...assignedEvent
          ...unassignedEvent

          ...labeledEvent
          ...unlabeledEvent

          ...reviewRequestedEvent
          ...reviewRequestRemovedEvent

          ...reviewDismissedEvent

          ...readyForReviewEvent
          ...convertToDraftEvent

          ...baseRefChangedEvent
          ...baseRefForcePushedEvent

          ...headRefForcePushedEvent
          ...headRefDeletedEvent
          ...headRefRestoredEvent

          ...crossReferencedEvent
          ...connectedEvent
          ...disconnectedEvent
        }
      }
    }
  }

  rateLimit {
    ...rates
  }
}
`;

export const removeReaction = `
mutation ($id: ID!, $reaction: ReactionContent!) {
  removeReaction(input: {
    subjectId: $id,
    content: $reaction
  }) {
    reaction {
      ...reaction
    }
  }
}
`;

export const resolveReviewThread = `
mutation ($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
        thread {
            ...pullRequestReviewThread
        }
    }
}
`;

export const submitReview = `
mutation ($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String){
    submitPullRequestReview(input: {pullRequestReviewId: $reviewId, event: $event, body: $body}) {
        __typename
    }
}
`;

export const unmarkFileAsViewed = `
mutation ($pullRequestId: ID!, $path: String!) {
    unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) {
        __typename
    }
}
`;

export const unresolveReviewThread = `
mutation ($threadId: ID!) {
    unresolveReviewThread(input: {threadId: $threadId}) {
        thread {
            ...pullRequestReviewThread
        }
    }
}
`;

export const updateIssueComment = `
mutation ($id: ID!, $body: String!) {
    updateIssueComment(input: {id: $id, body: $body}) {
        issueComment {
            ...comment
        }
    }
}
`;

export const updatePullRequest = `
mutation ($pullRequestId: ID!, $title: String, $body: String) {
    updatePullRequest(input: {pullRequestId: $pullRequestId, title: $title, body: $body}) {
        pullRequest {
            ...pullRequestInfo
        }
    }
}
`;

export const updateReview = `
mutation ($reviewId: ID!, $body: String!){
    updatePullRequestReview(input: {pullRequestReviewId: $reviewId, body: $body}) {
        pullRequestReview {
            ...pullRequestReview
        }
    }
}
`;

export const updateReviewComment = `
mutation ($id: ID!, $body: String!) {
    updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $id, body: $body}) {
        pullRequestReviewComment {
            ...pullRequestReviewComment
        }
    }
}
`;
