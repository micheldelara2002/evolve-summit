Feature: Evolve Summit — core business behavior

  Background:
    Given the Evolve Summit test environment is available
    And the regression event is configured

  @manager @P0
  Scenario: Manager can operate within the event scope
    Given I am authenticated as a manager
    When I open the regression event management area
    Then I can access the event modules allowed to managers
    And data shown belongs to the regression event

  @manager @P0 @security
  Scenario: Manager cannot cross event boundaries
    Given I am authenticated as a manager of Event A
    When I attempt to access Event B data using an Event B identifier
    Then the operation is denied or returns no unauthorized data

  @manager @P0 @bulk
  Scenario: Manager previews a valid CSV import
    Given I am authenticated as a manager
    And I have a CSV with valid required headers
    When I upload the CSV for the regression event
    Then the dry-run classifies rows as new, existing, linked, or invalid
    And no participant is created before confirmation

  @manager @P0 @bulk
  Scenario: Manager handles duplicate rows in the same CSV
    Given the CSV contains duplicate CPF or email values
    When I run the import preview
    Then duplicate rows are classified as invalid
    And the duplicate rows are not created

  @manager @P0 @bulk
  Scenario: Manager handles people existing in another event
    Given a person exists in the base but is not linked to the regression event
    When I upload that person's row
    Then the preview classifies it as existing but unlinked
    And I can choose to link or ignore

  @staff @P0
  Scenario: Staff sees only allowed event operations
    Given I am authenticated as staff in Event A
    When I open Event A
    Then I can access staff capabilities
    And I cannot access admin-only global operations

  @participant @P0
  Scenario: Participant can interact after check-in
    Given I am authenticated as a checked-in participant
    When I open my event
    Then the schedule is visible
    And I can favorite a session
    And my points/ranking context is visible

  @participant @P0
  Scenario: Participant without check-in is read-only
    Given I am authenticated as a participant without confirmed check-in
    When I open my event
    Then event interactions are blocked
    And the UI explains that check-in is pending

  @participant @P0 @gamification
  Scenario: Participant cannot receive duplicate points for a one-shot action
    Given a scoring rule is configured as one-shot
    When the same action is triggered twice
    Then only one PointTransaction is created
    And points_total increases only once

  @participant @P0 @store
  Scenario: Participant cannot redeem with insufficient points
    Given the participant has fewer points than the store item cost
    When I attempt the redemption
    Then the redemption is rejected
    And no stock is consumed

  @participant @P0 @network
  Scenario: Participant can send and manage a connection request
    Given I am an eligible participant in Event A
    When I send a connection request to another eligible participant in Event A
    Then the request becomes pending
    And the receiver can accept it
    And exactly one active Connection exists

  @speaker @P0
  Scenario: Speaker sees only own sessions and metrics
    Given I am authenticated as a speaker
    When I open the speaker dashboard
    Then my sessions are displayed
    And session reviews/attendance metrics are scoped to my sessions
    And another speaker's private session data is not displayed

  @speaker @P1
  Scenario: Speaker can manage session engagement
    Given I own a session
    When I answer an eligible question
    Then the answer is associated with my session
    And unrelated sessions are unchanged

  @partner @P0
  Scenario: Partner manager sees only partner-scoped data
    Given I am a partner manager
    When I open the partner dashboard
    Then I see only my partner's events and leads
    And another partner's leads are not visible

  @partner @P0
  Scenario: Partner representative cannot access partner administration
    Given I am a partner representative without manager permission
    When I open partner administration
    Then access is denied
    And I can still access my allowed event participation

  @all @P0 @security
  Scenario: Deleted account cannot execute protected mutations
    Given the account has status deleted
    When a protected backend mutation is attempted with the old session
    Then the mutation is rejected
    And no business data changes
