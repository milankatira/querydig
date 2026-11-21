package com.example.shop.orders;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import org.springframework.data.domain.PageRequest;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

interface OrderRepository extends JpaRepository<Order, Long> {
  List<Order> findByCustomerId(Long customerId);
  long countByCustomerIdAndStatus(Long customerId, String status);
  boolean existsByCustomerIdAndStatus(Long customerId, String status);

  // SQ006: function on a column in WHERE
  @Query("select o from Order o where lower(o.reference) = lower(?1)")
  Order findByReference(String reference);
}

@Service
public class OrderService {
  private final OrderRepository orderRepository;
  private final CustomerRepository customerRepository;
  private final JdbcTemplate jdbcTemplate;

  public OrderService(OrderRepository orderRepository, CustomerRepository customerRepository, JdbcTemplate jdbcTemplate) {
    this.orderRepository = orderRepository;
    this.customerRepository = customerRepository;
    this.jdbcTemplate = jdbcTemplate;
  }

  /** QD002 + SQ001 + SQ010: every customer, then one orders query per customer. */
  @Transactional(readOnly = true)
  public Map<Long, BigDecimal> revenuePerCustomer() {
    List<Customer> customers = customerRepository.findAll();
    Map<Long, BigDecimal> out = new java.util.HashMap<>();
    for (Customer c : customers) {
      List<Order> orders = orderRepository.findByCustomerId(c.getId());
      out.put(c.getId(), orders.stream().map(Order::getTotal).reduce(BigDecimal.ZERO, BigDecimal::add));
    }
    return out;
  }

  /** QD001 through a method reference. */
  public List<Customer> customersFor(List<Long> ids) {
    return ids.stream().map(customerRepository::findById).collect(Collectors.toList());
  }

  /** QD003: one INSERT per line item. */
  @Transactional
  public void importOrders(List<Order> incoming) {
    incoming.forEach(o -> orderRepository.save(o));
  }

  /** SQ009 (autofixable): count used as an existence check. */
  public boolean hasOpenOrders(Long customerId) {
    return orderRepository.countByCustomerIdAndStatus(customerId, "OPEN") > 0;
  }

  /** SQ002 + SQ003 + SQ005 in raw SQL. */
  public List<Map<String, Object>> search(String term, int page) {
    return jdbcTemplate.queryForList(
        "SELECT * FROM orders WHERE reference LIKE '%' || ? ORDER BY created_at DESC LIMIT 20 OFFSET ?", term, page * 20);
  }

  /** Fine: paged, filtered, batched. */
  public void ok(List<Long> ids) {
    customerRepository.findAll(PageRequest.of(0, 50));
    customerRepository.findAllById(ids);
    orderRepository.saveAll(List.of());
  }
}
