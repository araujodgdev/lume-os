// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenGadgetError, OPEN_GADGET_ERROR_CODES } from '@gadgets/workshop-shared/api'
import WorkspaceOpenErrorPage, { classifyWorkspaceOpenFailure } from './WorkspaceOpenErrorPage'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('./WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

describe('WorkspaceOpenErrorPage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  async function render(kind: 'access-denied' | 'not-found' | 'unexpected') {
    const onRetry = vi.fn<() => void>()
    const onGoToWorkspaces = vi.fn<() => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <WorkspaceOpenErrorPage
        kind={kind}
        onRetry={onRetry}
        onGoToWorkspaces={onGoToWorkspaces}
      />,
    ))
    return { container, onGoToWorkspaces, onRetry }
  }

  it('explains how to recover when access is denied without exposing workspace metadata', async () => {
    const { container: renderedContainer, onGoToWorkspaces, onRetry } = await render('access-denied')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe('Você não tem acesso a este espaço')
    expect(renderedContainer.textContent).toContain('Peça acesso a quem é dono do espaço e tente de novo.')
    expect(document.activeElement).toBe(renderedContainer.querySelector('h1'))

    const buttons = [...renderedContainer.querySelectorAll('button')]
    expect(buttons.map(button => button.textContent)).toEqual(['Ir para os espaços', 'Tentar de novo'])
    act(() => buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onGoToWorkspaces).toHaveBeenCalledOnce()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('gives a missing workspace a distinct, non-retryable state', async () => {
    const { container: renderedContainer } = await render('not-found')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe('Espaço não encontrado')
    expect(renderedContainer.textContent).toContain('O link pode estar errado, ou o espaço pode ter sido excluído.')
    expect([...renderedContainer.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Ir para os espaços'])
  })

  it('keeps unexpected failures retryable', async () => {
    const { container: renderedContainer } = await render('unexpected')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe('Não foi possível carregar este espaço')
    expect(renderedContainer.textContent).toContain('Tente de novo. Se o problema continuar, volte para os seus espaços.')
    expect([...renderedContainer.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Ir para os espaços', 'Tentar de novo'])
  })

  it('classifies stable open error codes without treating unexpected errors as expected', () => {
    expect(classifyWorkspaceOpenFailure(
      createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied),
    )).toBe('access-denied')
    expect(classifyWorkspaceOpenFailure(
      createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound),
    )).toBe('not-found')
    expect(classifyWorkspaceOpenFailure(
      new Error(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied),
    )).toBe('unexpected')
    expect(classifyWorkspaceOpenFailure(new Error('storage unavailable'))).toBe('unexpected')
  })
})
