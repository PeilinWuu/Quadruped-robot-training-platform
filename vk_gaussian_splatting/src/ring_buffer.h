#pragma once

#include <array>
#include <cstddef>
#include <stdexcept>
#include <utility>

namespace vk_gaussian_splatting {

template <typename T, std::size_t Capacity>
class RingBuffer
{
public:
  static constexpr std::size_t capacity() { return Capacity; }

  std::size_t size() const { return m_size; }
  bool        empty() const { return m_size == 0; }

  void clear()
  {
    m_start = 0;
    m_size  = 0;
  }

  void push(const T& value) { pushImpl(value); }
  void push(T&& value) { pushImpl(std::move(value)); }

  T& at(std::size_t index)
  {
    if(index >= m_size)
      throw std::out_of_range("RingBuffer index out of range");
    return m_data[physicalIndex(index)];
  }

  const T& at(std::size_t index) const
  {
    if(index >= m_size)
      throw std::out_of_range("RingBuffer index out of range");
    return m_data[physicalIndex(index)];
  }

  T& operator[](std::size_t index) { return at(index); }
  const T& operator[](std::size_t index) const { return at(index); }

private:
  template <typename U>
  void pushImpl(U&& value)
  {
    if constexpr(Capacity == 0)
      return;

    const std::size_t destination = m_size < Capacity ? physicalIndex(m_size) : m_start;
    m_data[destination]           = std::forward<U>(value);
    if(m_size < Capacity)
      ++m_size;
    else
      m_start = (m_start + 1) % Capacity;
  }

  std::size_t physicalIndex(std::size_t logicalIndex) const
  {
    if constexpr(Capacity == 0)
      return 0;
    return (m_start + logicalIndex) % Capacity;
  }

  std::array<T, Capacity> m_data{};
  std::size_t             m_start{0};
  std::size_t             m_size{0};
};

}  // namespace vk_gaussian_splatting
