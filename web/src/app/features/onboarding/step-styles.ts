/** Layout shared by every onboarding step and the sign-in page (onboarding mockup). */
export const stepStyles = `
  :host {
    display: flex;
    flex-direction: column;
    gap: 40px;
  }

  .intro {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  h1 {
    font-size: 34px;
    font-weight: 700;
    letter-spacing: -0.025em;
  }

  .intro p {
    font-size: 15px;
    line-height: 1.55;
    color: var(--text-lead);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 40px;
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-top: 8px;
  }

  .form-error {
    font-size: 13px;
    color: var(--status-failed);
  }

  .form-error:empty {
    visibility: hidden;
  }
`;
