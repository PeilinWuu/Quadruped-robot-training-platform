// @vitest-environment jsdom
import { Entity, Quat, Vec3 } from 'playcanvas'
import { describe, expect, it, vi } from 'vitest'
import {
  orbitFrame,
  PlayCanvasCameraController,
  rotateOrbitQuaternion,
} from '../../features/gaussian-viewer/renderer/PlayCanvasCameraController'

function expectVector(actual: Vec3, expected: Vec3): void {
  expect(actual.x).toBeCloseTo(expected.x, 9)
  expect(actual.y).toBeCloseTo(expected.y, 9)
  expect(actual.z).toBeCloseTo(expected.z, 9)
}

describe('quaternion orbit controller', () => {
  it.each([
    ['horizontal', 90, 0],
    ['vertical', 0, 90],
  ] as const)('returns to an equivalent pose after a full %s orbit', (_name, horizontal, vertical) => {
    let rotation = new Quat()
    for (let index = 0; index < 4; index += 1) {
      rotation = rotateOrbitQuaternion(rotation, horizontal, vertical)
    }
    const frame = orbitFrame(new Vec3(), 3, rotation)
    expectVector(frame.position, new Vec3(0, 0, 3))
    expectVector(frame.up, new Vec3(0, 1, 0))
    expect(rotation.length()).toBeCloseTo(1, 12)
  })

  it('crosses 90 and 180 degrees without non-finite pose values', () => {
    let rotation = rotateOrbitQuaternion(new Quat(), 0, 100)
    rotation = rotateOrbitQuaternion(rotation, 0, 100)
    const frame = orbitFrame(new Vec3(), 3, rotation)
    for (const value of [
      frame.position.x, frame.position.y, frame.position.z,
      frame.right.x, frame.right.y, frame.right.z,
      frame.up.x, frame.up.y, frame.up.z,
    ]) expect(Number.isFinite(value)).toBe(true)
  })

  it('keeps pan axes and zoom distance valid after crossing a pole', () => {
    const rotation = rotateOrbitQuaternion(new Quat(), 35, 200)
    const frame = orbitFrame(new Vec3(), 0, rotation)
    expect(frame.right.length()).toBeCloseTo(1, 12)
    expect(frame.up.length()).toBeCloseTo(1, 12)
    expect(frame.right.dot(frame.up)).toBeCloseTo(0, 12)
    const pannedTarget = frame.right.clone().mulScalar(2).add(frame.up)
    const zoomed = orbitFrame(pannedTarget, 0.01, rotation)
    expect(Number.isFinite(zoomed.position.length())).toBe(true)
  })

  it('removes pointer and wheel behavior after dispose', () => {
    const canvas = document.createElement('canvas')
    const render = vi.fn()
    const controller = new PlayCanvasCameraController(canvas, new Entity('camera'), render)
    controller.setEnabled(true)
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, cancelable: true }))
    expect(render).toHaveBeenCalledTimes(1)
    controller.dispose()
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, cancelable: true }))
    expect(render).toHaveBeenCalledTimes(1)
    expect(controller.isEnabled()).toBe(false)
  })
})
