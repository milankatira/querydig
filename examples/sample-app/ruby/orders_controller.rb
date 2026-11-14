# Sample Rails controller with planted query problems for querydig.
class OrdersController < ApplicationController
  # SQ001: loads the whole orders table
  def index
    @orders = Order.all
  end

  # QD002: one query per user, per row of another query (N+1)
  def summary
    @users = User.where(active: true)
    @users.each do |user|
      user.orders.where(status: 'paid').sum(:total)
    end
  end

  # SQ009: COUNT used as an existence check (autofix: .exists?)
  def show
    @order = Order.find(params[:id])
    head :no_content if @order.line_items.count == 0
    flash[:notice] = 'Has refunds' if Refund.where(order_id: @order.id).count > 0
  end

  # SQ010: whole table iterated in memory (autofix: find_each)
  def reindex
    Order.all.each do |order|
      SearchIndex.push(order)
    end
  end

  # QD003: one UPDATE per row; use update_all
  def archive
    Order.where(state: 'stale').find_each do |order|
      order.update(state: 'archived')
    end
  end

  # SQ003: leading-wildcard LIKE; SQ005: OFFSET pagination
  def search
    @orders = Order.where('reference LIKE ?', "%#{params[:q]}%").offset(params[:page].to_i * 50).limit(50)
  end

  # SQ002 + SQ004: raw SQL without WHERE / LIMIT
  def export
    ActiveRecord::Base.connection.select_all(<<~SQL)
      SELECT * FROM orders
    SQL
  end
end
